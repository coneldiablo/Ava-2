import { usePeriod } from '../hooks/usePeriod';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useBusinessAccess } from '../permissions';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import {
    getAnalyticsFunnel, getAnalyticsAvgTime, getAnalyticsExportUrl,
    getAnalyticsHeatmap, getAnalyticsMessagesOverTime, getAnalyticsChannelBreakdown,
    getAnalyticsResponseTimes, getAnalyticsSmartSummary, getAnalyticsLeadsOverTime,
    getRevenueForecast, getCallAnalytics, getPayments,
} from '../api';
import {
    AlertCircle, TrendingDown, TrendingUp, Clock, Download, RefreshCw, FileText,
    FileSpreadsheet, AlertTriangle, Users, Zap, MessageSquare,
    Activity, Timer, Hash, Flame, Target,
    Wallet, Send, Mail, Smartphone, PhoneCall,
} from 'lucide-react';
import { getPipeline, isCoffeeBusiness } from '../businessProfiles';
import './Analytics.css';
import KnowledgeReview from '../components/knowledge/KnowledgeReview';

// ═══════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════

interface FunnelTransition { fromStatus: string; toStatus: string; count: number; }
interface FunnelHole { from: string; to: string; advancedCount: number; totalFromStatus: number; dropRate: number; }
interface FunnelData { transitions: FunnelTransition[]; pipeline: Record<string, number>; holes: FunnelHole[]; bottleneck: FunnelHole | null; }
interface AvgTimeItem { status: string; avgHours: number; avgDays: number; sampleCount: number; }
interface AvgTimeData { data: AvgTimeItem[]; bottleneck: AvgTimeItem | null; }
interface HeatmapCell { dayOfWeek: number; hour: number; count: number; }
interface MsgDay { date: string; incoming: number; outgoing: number; total: number; }
interface ChannelRow { channel: string; count: number; }
interface ResponseTimeData { avgSeconds: number; medianSeconds: number; totalSamples: number; under30s: number; under60s: number; under300s: number; }
interface SmartSummary { totalClients: number; conversionRate: number; bookedClients: number; activeLeads: number; staleLeads: number; msgsToday: number; thisWeekLeads: number; velocityChange: number; triggersExecuted: number; profilesBuilt: number; activeSequences: number; statsByStatus: Record<string, number>; }
interface LeadDay { date: string; count: number; successTransitions: number; }
interface DealAmountByCurrency { currency: string; openAmount: number; wonAmount: number; openDeals: number; wonDeals: number; }
interface ForecastDeal { id: string; chatId: string | null; title: string; clientName?: string | null; stage: string; amount: number; currency: string; nextActionAt?: string | null; }
interface DealSummary { source: 'customer_deals'; amountsByCurrency: DealAmountByCurrency[]; succeededPaymentsRUB: number; activeDeals: number; completedDeals: number; deals: ForecastDeal[]; }
interface CallAnalyticsStats {
    total_calls: number;
    avg_duration_seconds: number;
    total_duration_seconds: number;
    outcomes: Record<string, number>;
    providers: Record<string, number>;
    directions: Record<string, number>;
    calls_per_day: { date: string; count: number }[];
}
interface CallAnalyticsResponse { success: boolean; business_id: number; period_days: number; generated_at: string; stats: CallAnalyticsStats; }

// ═══════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════

const STATUS_LABELS: Record<string, string> = {
    new: 'Новые', qualified: 'Квалификация', audit: 'Аудит',
    offer: 'КП отправлено', pickup_confirmed: 'Самовывоз ✓', ready_for_pickup: 'Готов к выдаче', booked: 'Записаны ✓', junk: 'Отказ',
};
const STATUS_COLORS: Record<string, string> = {
    new: '#36323f', qualified: '#403a50', audit: '#4b4262',
    offer: '#50457c', pickup_confirmed: '#4c3d91', ready_for_pickup: '#392e72', booked: '#342b65', junk: '#514d5a',
};
const SALES_FUNNEL_ORDER = ['new', 'qualified', 'audit', 'offer', 'booked'];
const COFFEE_FUNNEL_ORDER = ['new', 'qualified', 'audit', 'offer', 'pickup_confirmed', 'ready_for_pickup'];
const DAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const CHANNEL_LABELS: Record<string, { label: string; icon: typeof MessageSquare }> = {
    whatsapp: { label: 'WhatsApp', icon: MessageSquare },
    telegram: { label: 'Telegram', icon: Send },
    email: { label: 'Email', icon: Mail },
    vk: { label: 'ВКонтакте', icon: MessageSquare },
    max: { label: 'MAX', icon: MessageSquare },
    instagram: { label: 'Instagram', icon: MessageSquare },
};

const DEAL_STAGE_LABELS: Record<string, string> = {
    new: 'Новая', qualified: 'Квалификация', proposal: 'Предложение',
    negotiation: 'Переговоры', won: 'Выиграна', lost: 'Проиграна',
};
const CALL_OUTCOME_LABELS: Record<string, string> = {
    completed: 'Завершён', answered: 'Ответили', no_answer: 'Без ответа',
    busy: 'Занято', failed: 'Ошибка', canceled: 'Отменён', transferred: 'Переведён',
    voicemail: 'Автоответчик', voicemail_drop: 'Сообщение оставлено',
};

function formatDealAmount(amount: number, currency: string): string {
    try {
        return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
        return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
    }
}

function fmtTime(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)} мин`;
    if (hours < 24) return `${hours.toFixed(1)} ч`;
    return `${(hours / 24).toFixed(1)} дн`;
}
function fmtSeconds(s: number): string {
    if (s < 60) return `${s}с`;
    if (s < 3600) return `${Math.floor(s / 60)}м ${s % 60}с`;
    return `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`;
}

// ═══════════════════════════════════════════════
// KPI Card
// ═══════════════════════════════════════════════

function KpiCard({ icon, label, value, sub, href }: {
    icon: React.ReactNode; label: string; value: string | number; sub?: string; href: string;
}) {
    return (
        <Link to={href} className="analytics-kpi flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <span className="analytics-kpi-label">{label}</span>
                <div className="analytics-kpi-icon">
                    {icon}
                </div>
            </div>
            <div className="flex items-end gap-2">
                <span className="analytics-kpi-value">{value}</span>
                {sub && <span className="analytics-kpi-sub">{sub}</span>}
            </div>
        </Link>
    );
}

// ═══════════════════════════════════════════════
// AI Insights Panel
// ═══════════════════════════════════════════════


// ═══════════════════════════════════════════════
// Activity Heatmap
// ═══════════════════════════════════════════════

function ActivityHeatmap({ data }: { data: HeatmapCell[] }) {
    const maxCount = Math.max(...data.map(d => d.count), 1);
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    data.forEach(d => { grid[d.dayOfWeek][d.hour] = d.count; });

    return (
        <div>
        <div className="overflow-x-auto" role="img" aria-label={`Активность по дням недели и часам: ${data.reduce((total, cell) => total + cell.count, 0)} сообщений`}>
            <div className="min-w-[600px]">
                {/* Hour labels */}
                <div className="flex gap-0.5 ml-10 mb-1">
                    {Array.from({ length: 24 }, (_, h) => (
                        <div key={h} className="flex-1 text-center analytics-chart-axis">{h % 3 === 0 ? `${h}` : ''}</div>
                    ))}
                </div>
                {/* Rows */}
                {[1, 2, 3, 4, 5, 6, 0].map(day => (
                    <div key={day} className="flex items-center gap-0.5 mb-0.5">
                        <span className="w-9 text-right analytics-chart-axis pr-1">{DAY_SHORT[day]}</span>
                        {grid[day].map((count, h) => {
                            const intensity = count / maxCount;
                            const bg = count === 0 ? '#e8e9ed' : `rgba(33, 31, 42, ${0.3 + intensity * 0.7})`;
                            return (
                                <div key={h} title={`${DAY_SHORT[day]} ${String(h).padStart(2, '0')}:00 — ${count} сообщ.`} className="flex-1 h-6 rounded-sm relative group"
                                    style={{ backgroundColor: bg }}>
                                    {count > 0 && (
                                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-[#22262f] border border-[#2a2e3a] rounded text-[10px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-20 shadow-lg">
                                            {DAY_SHORT[day]} {String(h).padStart(2, '0')}:00 — {count} сообщ.
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}
                {/* Legend */}
                <div className="flex items-center justify-end gap-2 mt-2 mr-1">
                    <span className="analytics-chart-axis">Меньше</span>
                    {[0.1, 0.3, 0.5, 0.7, 0.9].map(v => (
                        <div key={v} className="w-4 h-4 rounded-sm" style={{ backgroundColor: `rgba(17, 17, 17, ${v})` }} />
                    ))}
                    <span className="analytics-chart-axis">Больше</span>
                </div>
            </div>
        </div>
        <details className="analytics-data-details">
            <summary>Данные тепловой карты таблицей</summary>
            <div className="overflow-x-auto"><table><thead><tr><th scope="col">День</th><th scope="col">Час</th><th scope="col">Сообщения</th></tr></thead><tbody>
                {data.filter(cell => cell.count > 0).map(cell => <tr key={`${cell.dayOfWeek}-${cell.hour}`}><td>{DAY_SHORT[cell.dayOfWeek]}</td><td>{String(cell.hour).padStart(2, '0')}:00</td><td>{cell.count}</td></tr>)}
            </tbody></table>{!data.some(cell => cell.count > 0) && <p>За выбранный период сообщений нет.</p>}</div>
        </details>
        </div>
    );
}

// ═══════════════════════════════════════════════
// Messages Bar Chart (pure SVG)
// ═══════════════════════════════════════════════

export function MessagesChart({ data }: { data: MsgDay[] }) {
    if (data.length === 0) return <p className="text-sm text-[#8b8fa3] text-center py-8">Нет данных за выбранный период</p>;

    const W = 700, H = 200, padL = 35, padB = 28, padT = 10, padR = 10;
    const chartW = W - padL - padR;
    const chartH = H - padB - padT;
    const tickStep = Math.max(1, Math.ceil(Math.max(...data.map(d => d.total), 1) / 4));
    const maxVal = tickStep * 4;
    const barW = Math.max(3, Math.min(16, (chartW / data.length) * 0.65));
    const gap = (chartW - barW * data.length) / (data.length + 1);

    return (
        <div>
        <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 400 }} role="img" aria-label={`Сообщения за ${data.length} дней: ${data.reduce((total, day) => total + day.incoming, 0)} входящих и ${data.reduce((total, day) => total + day.outgoing, 0)} исходящих`}>
                {/* Grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map(f => {
                    const y = padT + chartH * (1 - f);
                    return (
                        <g key={f}>
                            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#d6d7dc" strokeWidth={0.5} />
                            <text x={padL - 4} y={y + 3} textAnchor="end" fontSize={10} fill="#55515e">{Math.round(maxVal * f)}</text>
                        </g>
                    );
                })}
                {/* Bars */}
                {data.map((d, i) => {
                    const x = padL + gap + i * (barW + gap);
                    const inH = (d.incoming / maxVal) * chartH;
                    const outH = (d.outgoing / maxVal) * chartH;
                    const inY = padT + chartH - inH;
                    const label = d.date.slice(5); // MM-DD
                    return (
                        <g key={d.date}>
                            {/* Incoming bar (bottom) */}
                            <rect x={x} y={inY} width={barW} height={inH} rx={2} fill="#211f2a" />
                            {/* Outgoing bar (stacked on top) */}
                            <rect x={x} y={inY - outH} width={barW} height={outH} rx={2} fill="#8774d5" />
                            {/* Date label (every few) */}
                            {(i % Math.max(1, Math.floor(data.length / 10)) === 0) && (
                                <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#55515e">{label}</text>
                            )}
                            {/* Tooltip area */}
                            <rect x={x - gap / 2} y={padT} width={barW + gap} height={chartH} fill="transparent" className="cursor-pointer">
                                <title>{d.date}: ↓{d.incoming} ↑{d.outgoing} (Σ{d.total})</title>
                            </rect>
                        </g>
                    );
                })}
            </svg>
            <div className="analytics-message-legend" aria-hidden="true"><span><i />Входящие</span><span><i />Исходящие</span></div>
        </div>
        <details className="analytics-data-details">
            <summary>Сообщения по дням таблицей</summary>
            <div className="overflow-x-auto"><table><thead><tr><th scope="col">Дата</th><th scope="col">Входящие</th><th scope="col">Исходящие</th><th scope="col">Всего</th></tr></thead><tbody>
                {data.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.incoming}</td><td>{day.outgoing}</td><td>{day.total}</td></tr>)}
            </tbody></table></div>
        </details>
        </div>
    );
}

// ═══════════════════════════════════════════════
// Leads Over Time (sparkline)
// ═══════════════════════════════════════════════

function LeadsSparkline({ data }: { data: LeadDay[] }) {
    if (data.length < 2) return null;
    const W = 200, H = 50;
    const maxV = Math.max(...data.map(d => d.count), 1);
    const points = data.map((d, i) => {
        const x = (i / (data.length - 1)) * W;
        const y = H - (d.count / maxV) * (H - 6) - 3;
        return `${x},${y}`;
    }).join(' ');
    const areaPoints = `0,${H} ${points} ${W},${H}`;
    return (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`Новые лиды за ${data.length} дней: ${data.reduce((total, day) => total + day.count, 0)}`}>
            <polygon points={areaPoints} fill="url(#sparkGrad)" />
            <polyline points={points} fill="none" stroke="#211f2a" strokeWidth={1.5} />
            <defs>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8774d5" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#8774d5" stopOpacity="0" />
                </linearGradient>
            </defs>
        </svg>
    );
}

function LeadOutcomesCard({ data, isCoffee }: { data: LeadDay[]; isCoffee: boolean }) {
    const width = 640, height = 132, pad = 12;
    const max = Math.max(...data.flatMap(day => [day.count, day.successTransitions]), 1);
    const points = (field: 'count' | 'successTransitions') => data.map((day, index) => {
        const x = pad + (index / Math.max(data.length - 1, 1)) * (width - 2 * pad);
        const y = height - pad - (day[field] / max) * (height - 2 * pad);
        return `${x},${y}`;
    }).join(' ');
    const first = data[0]?.date;
    const last = data[data.length - 1]?.date;
    const successes = data.reduce((sum, day) => sum + day.successTransitions, 0);
    return <section className="analytics-outcomes card mb-6" aria-labelledby="analytics-outcomes-title">
        <div className="card-header flex items-center gap-2"><TrendingUp size={18} aria-hidden="true" />
            <div><h3 id="analytics-outcomes-title" className="font-semibold">Новые лиды и первые успешные переходы</h3>
                <p className="analytics-outcomes-sub">{first} — {last} · {successes} {isCoffee ? 'первых подтверждений самовывоза' : 'первых записей'}</p></div>
        </div>
        <div className="card-body">
            <div className="analytics-outcomes-legend" aria-hidden="true"><span><i className="analytics-outcomes-new" />Новые лиды</span><span><i className="analytics-outcomes-success" />{isCoffee ? 'Подтверждён самовывоз' : 'Записаны'}</span></div>
            <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="132" role="img" aria-label={`Динамика за ${data.length} дней: новые лиды — ${data.reduce((sum, day) => sum + day.count, 0)}, впервые достигли результата — ${successes}`}>
                <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke="#c9c7d0" />
                <polyline points={points('count')} fill="none" stroke="#26232d" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points={points('successTransitions')} fill="none" stroke="#6954aa" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="7 5" />
            </svg>
            <p className="analytics-outcomes-sub">Успешный переход учитывается один раз для каждого клиента за всю историю бизнеса; это не конверсия лидов, созданных в тот же день.</p>
            <details className="analytics-outcomes-details"><summary>Показать данные по дням</summary><div className="overflow-x-auto"><table>
                <thead><tr><th>Дата</th><th>Новые лиды</th><th>{isCoffee ? 'Первое подтверждение самовывоза' : 'Первая запись'}</th></tr></thead>
                <tbody>{data.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.count}</td><td>{day.successTransitions}</td></tr>)}</tbody>
            </table></div></details>
        </div>
    </section>;
}

// ═══════════════════════════════════════════════
// Channel Breakdown (donut-like bars)
// ═══════════════════════════════════════════════

function ChannelBreakdown({ data }: { data: ChannelRow[] }) {
    const total = data.reduce((s, d) => s + d.count, 0) || 1;
    return (
        <div className="space-y-3">
            {data.map(ch => {
                const info = CHANNEL_LABELS[ch.channel] || { label: ch.channel, icon: Smartphone };
                const pct = Math.round((ch.count / total) * 100);
                return (
                    <div key={ch.channel}>
                        <div className="flex items-center justify-between text-sm mb-1">
                            <span className="flex items-center gap-2">
                                <info.icon size={16} aria-hidden="true" />
                                <span className="text-white font-medium">{info.label}</span>
                            </span>
                            <span className="text-[#8b8fa3]">{ch.count} <span className="text-[10px]">({pct}%)</span></span>
                        </div>
                        <div className="w-full h-2 bg-[#22262f] rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: '#211f2a' }} />
                        </div>
                    </div>
                );
            })}
            {data.length === 0 && <p className="text-sm text-[#8b8fa3] text-center py-4">Нет данных о каналах</p>}
        </div>
    );
}

// ═══════════════════════════════════════════════
// Response Time Gauge
// ═══════════════════════════════════════════════

function ResponseTimeGauge({ data }: { data: ResponseTimeData }) {
    if (data.totalSamples === 0) return <p className="text-sm text-[#8b8fa3] text-center py-6">Нет данных о времени ответа</p>;

    const pctUnder30 = Math.round((data.under30s / data.totalSamples) * 100);
    const pctUnder60 = Math.round((data.under60s / data.totalSamples) * 100);
    const pctUnder300 = Math.round((data.under300s / data.totalSamples) * 100);

    const rating = data.avgSeconds <= 15 ? 'Очень быстро' : data.avgSeconds <= 30 ? 'Быстро' : data.avgSeconds <= 60 ? 'Хорошо' : data.avgSeconds <= 180 ? 'Нормально' : 'Медленно';
    const ratingColor = data.avgSeconds <= 30 ? 'analytics-rating--good' : data.avgSeconds <= 60 ? 'analytics-rating--medium' : 'analytics-rating--slow';

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-3xl font-bold text-white">{fmtSeconds(data.avgSeconds)}</p>
                    <p className="text-xs text-[#8b8fa3]">Среднее время ответа</p>
                </div>
                <div className="text-right">
                    <p className={`text-lg font-bold ${ratingColor}`}>{rating}</p>
                    <p className="text-xs text-[#8b8fa3]">Медиана: {fmtSeconds(data.medianSeconds)}</p>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
                {[
                    { label: '< 30с', pct: pctUnder30, color: '#211f2a' },
                    { label: '< 1мин', pct: pctUnder60, color: '#625a77' },
                    { label: '< 5мин', pct: pctUnder300, color: '#8774d5' },
                ].map(b => (
                    <div key={b.label} className="text-center">
                        <div className="relative w-14 h-14 mx-auto mb-1">
                            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90" role="img" aria-label={`${b.pct}% ответов ${b.label}`}>
                                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e7e7e7" strokeWidth="3" />
                                <circle cx="18" cy="18" r="15.5" fill="none" stroke={b.color} strokeWidth="3"
                                    strokeDasharray={`${b.pct * 0.974} 100`} strokeLinecap="round" />
                            </svg>
                            <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white" aria-hidden="true">{b.pct}%</span>
                        </div>
                        <span className="text-[10px] text-[#8b8fa3]">{b.label}</span>
                    </div>
                ))}
            </div>
            <p className="text-[10px] text-[#6b6f80] text-center">На основе {data.totalSamples} ответов за 30 дней</p>
        </div>
    );
}

// ═══════════════════════════════════════════════
// Sankey Funnel (keep from original)
// ═══════════════════════════════════════════════

export function SankeyFunnel({ data, statuses, labels }: { data: FunnelData; statuses: string[]; labels: Record<string, string> }) {
    const W = 600, H = 300, nodeW = 85;
    const gap = (W - nodeW * statuses.length) / (statuses.length - 1);
    const maxPipeline = Math.max(...statuses.map(s => data.pipeline[s] || 0), 1);

    const nodes = statuses.map((status, i) => {
        const count = data.pipeline[status] || 0;
        const barH = Math.max(8, (count / maxPipeline) * (H - 80));
        const x = i * (nodeW + gap);
        const y = (H - 40 - barH) / 2 + 20;
        return { status, count, x, y, h: barH };
    });

    const paths: { d: string; color: string; opacity: number; label: string }[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
        const from = nodes[i], to = nodes[i + 1];
        const total = from.count || 1;
        const advanced = data.transitions.find(t => t.fromStatus === from.status && t.toStatus === to.status);
        const advCount = advanced?.count || 0;
        const ratio = Math.min(advCount / total, 1);

        const fromH = from.h * ratio, toH = to.h * ratio;
        const cx1 = from.x + nodeW + (gap * 0.45), cx2 = to.x - (gap * 0.05);
        const fromY = from.y + (from.h - fromH) / 2, toY = to.y + (to.h - toH) / 2;

        const d = `M ${from.x + nodeW} ${fromY} C ${cx1} ${fromY}, ${cx2} ${toY}, ${to.x} ${toY} L ${to.x} ${toY + toH} C ${cx2} ${toY + toH}, ${cx1} ${fromY + fromH}, ${from.x + nodeW} ${fromY + fromH} Z`;
        const hole = data.holes.find(h => h.from === from.status && h.to === to.status);
        const isWorst = data.bottleneck?.from === from.status;
        const pct = hole && hole.totalFromStatus > 0 ? Math.round(100 - hole.dropRate) : null;
        paths.push({ d, color: isWorst ? '#555555' : STATUS_COLORS[from.status], opacity: 0.45, label: pct === null ? '—' : `${pct}%` });
    }

    return (
        <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 440 }} role="img" aria-label={`Воронка конверсий: ${nodes.map(node => `${labels[node.status] || STATUS_LABELS[node.status]} — ${node.count}`).join(', ')}`}>
                {paths.map((p, i) => {
                    const fromN = nodes[i], toN = nodes[i + 1];
                    const midX = fromN.x + nodeW + (gap / 2) - 16;
                    const midY = (fromN.y + toN.y) / 2 + fromN.h / 4;
                    return (
                        <g key={i}>
                            <path d={p.d} fill={p.color} opacity={p.opacity} />
                            <rect x={midX} y={midY - 10} width={32} height={18} rx={9} fill={p.color} opacity={0.9} />
                            <text x={midX + 16} y={midY + 4} textAnchor="middle" fontSize={11} fill="white" fontWeight="700">{p.label}</text>
                        </g>
                    );
                })}
                {nodes.map(n => (
                    <g key={n.status}>
                        <rect x={n.x} y={n.y} width={nodeW} height={n.h} rx={6} fill={STATUS_COLORS[n.status]} opacity={0.9} />
                        <text x={n.x + nodeW / 2} y={n.y - 8} textAnchor="middle" fontSize={10} fill="#555555" fontWeight="600">{labels[n.status] || STATUS_LABELS[n.status]}</text>
                        <text x={n.x + nodeW / 2} y={n.h > 28 ? n.y + n.h / 2 + 5 : n.y + n.h + 18} textAnchor="middle" fontSize={n.h > 28 ? 18 : 13} fill={n.h > 28 ? 'white' : '#333333'} fontWeight="700">{n.count}</text>
                    </g>
                ))}
            </svg>
        </div>
    );
}

// ═══════════════════════════════════════════════
// Avg Time Chart
// ═══════════════════════════════════════════════

function AvgTimeChart({ data, bottleneck, statuses, labels }: { data: AvgTimeItem[]; bottleneck: AvgTimeItem | null; statuses: string[]; labels: Record<string, string> }) {
    const allStatuses = [...statuses, 'junk'];
    const maxH = Math.max(...data.map(d => d.avgHours), 1);
    return (
        <div className="space-y-3">
            {allStatuses.map(st => {
                const item = data.find(d => d.status === st);
                const hrs = item?.avgHours || 0;
                const pct = (hrs / maxH) * 100;
                const isB = bottleneck?.status === st && hrs > 0;
                const c = isB ? '#555555' : STATUS_COLORS[st];
                return (
                    <div key={st} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[st] }} />
                                <span className="text-[#e4e6eb]">{labels[st] || STATUS_LABELS[st]}</span>
                                {isB && <span className="inline-flex items-center gap-1 text-[10px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-full"><AlertTriangle size={9} /> Узкое место</span>}
                            </div>
                            <div className="text-right">
                                <span className="font-bold text-white" style={{ color: c }}>{hrs > 0 ? fmtTime(hrs) : '—'}</span>
                                {item && item.sampleCount > 0 && <span className="text-[10px] text-[#8b8fa3] ml-1.5">({item.sampleCount})</span>}
                            </div>
                        </div>
                        <div className="w-full h-2 bg-[#22262f] rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: c }} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ═══════════════════════════════════════════════
// Export Panel
// ═══════════════════════════════════════════════

function ExportPanel({ instanceId }: { instanceId: number }) {
    const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const invalidRange = !!dateFrom && !!dateTo && dateFrom > dateTo;

    const handleExport = () => {
        if (invalidRange) return;
        const url = getAnalyticsExportUrl(instanceId, format, dateFrom || undefined, dateTo || undefined);
        const a = document.createElement('a'); a.href = url; a.download = '';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    };

    return (
        <div className="space-y-4">
            <div className="flex gap-2">
                {[{ f: 'xlsx' as const, icon: <FileSpreadsheet size={14} />, label: 'Excel' }, { f: 'csv' as const, icon: <FileText size={14} />, label: 'CSV' }].map(o => (
                    <button key={o.f} type="button" aria-pressed={format === o.f} onClick={() => setFormat(o.f)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${format === o.f ? 'border-[#00c2ff] bg-[#00c2ff]/10 text-[#00c2ff]' : 'border-[#2a2e3a] text-[#8b8fa3] hover:border-[#3a3e4a]'}`}>
                        {o.icon} {o.label}
                    </button>
                ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label htmlFor="analytics-date-from" className="block text-[10px] text-[#8b8fa3] mb-1">Дата с</label>
                    <input id="analytics-date-from" type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)}
                        className="w-full bg-[#22262f] border border-[#2a2e3a] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00c2ff]" />
                </div>
                <div>
                    <label htmlFor="analytics-date-to" className="block text-[10px] text-[#8b8fa3] mb-1">Дата по</label>
                    <input id="analytics-date-to" type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)}
                        className="w-full bg-[#22262f] border border-[#2a2e3a] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00c2ff]" />
                </div>
            </div>
            {invalidRange && <p className="analytics-range-error" role="alert">Конечная дата должна быть не раньше начальной.</p>}
            <button type="button" disabled={invalidRange} onClick={handleExport}
                className="w-full flex items-center justify-center gap-2 bg-[#00c2ff] hover:bg-[#1ebe5d] text-white font-semibold py-2.5 px-6 rounded-xl transition-colors text-sm">
                <Download size={16} /> Скачать {format.toUpperCase()}
            </button>
        </div>
    );
}

function CallAnalytics({ data, days, onDaysChange, loading, error }: {
    data: CallAnalyticsResponse | null;
    days: 7 | 30 | 90;
    onDaysChange: (days: 7 | 30 | 90) => void;
    loading: boolean;
    error: string;
}) {
    const stats = data?.stats;
    const daily = [...(stats?.calls_per_day || [])].sort((a, b) => a.date.localeCompare(b.date));
    const maxDaily = Math.max(1, ...daily.map(day => day.count));
    const outcomes = Object.entries(stats?.outcomes || {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    const directions = Object.entries(stats?.directions || {}).filter(([, count]) => count > 0);
    const providers = Object.entries(stats?.providers || {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    return <section id="analytics-calls" className="card analytics-calls mb-6" aria-labelledby="analytics-calls-title">
        <header className="card-header analytics-calls-header">
            <PhoneCall size={18} aria-hidden="true" />
            <div><h3 id="analytics-calls-title" className="font-semibold">Звонки AVA</h3><p>Сохранённые вызовы выбранного бизнеса · даты по UTC</p></div>
            <Link to={`/reports?type=calls&days=${days}`} className="analytics-deals-link">Отчёт за этот период</Link>
        </header>
        <div className="card-body">
            <div className="analytics-calls-periods" role="group" aria-label="Период статистики звонков">
                {([7, 30, 90] as const).map(period => <button type="button" key={period} onClick={() => onDaysChange(period)}
                    aria-pressed={days === period} disabled={loading}>За {period} дней</button>)}
            </div>
            {loading && <p className="analytics-calls-state" role="status">Загружаем статистику звонков…</p>}
            {!loading && error && <p className="analytics-calls-state is-error" role="alert">{error}</p>}
            {!loading && !error && stats && stats.total_calls === 0 && <p className="analytics-calls-state">За выбранный период звонков нет. Когда появятся сохранённые вызовы, здесь будут реальные показатели.</p>}
            {!loading && !error && stats && stats.total_calls > 0 && <>
                <div className="analytics-calls-kpis" aria-label="Ключевые показатели звонков">
                    <div><span>Всего звонков</span><strong>{stats.total_calls}</strong></div>
                    <div><span>Входящих</span><strong>{stats.directions?.inbound || 0}</strong></div>
                    <div><span>Исходящих</span><strong>{stats.directions?.outbound || 0}</strong></div>
                    <div><span>Средняя длительность</span><strong>{fmtSeconds(Math.round(stats.avg_duration_seconds || 0))}</strong></div>
                </div>
                <div className="analytics-calls-grid">
                    <div>
                        <h4>Звонки по дням</h4>
                        {daily.length ? <>
                            <div className="analytics-calls-chart" role="img" aria-label={daily.map(day => `${day.date}: ${day.count}`).join('; ')}>
                                {daily.map(day => <span key={day.date} title={`${day.date}: ${day.count} звонков`} style={{ height: `${Math.max(5, day.count / maxDaily * 100)}%` }} />)}
                            </div>
                            <details className="analytics-data-details"><summary>Данные графика таблицей</summary>
                                <div className="overflow-x-auto"><table><thead><tr><th scope="col">Дата UTC</th><th scope="col">Звонки</th></tr></thead>
                                    <tbody>{daily.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.count}</td></tr>)}</tbody></table></div>
                            </details>
                        </> : <p>Данных по дням пока нет.</p>}
                    </div>
                    <div><h4>Результаты</h4>{outcomes.length ? <dl className="analytics-calls-breakdown">{outcomes.map(([outcome, count]) => <div key={outcome}><dt>{CALL_OUTCOME_LABELS[outcome] || outcome}</dt><dd>{count}</dd></div>)}</dl> : <p>Результаты не указаны.</p>}</div>
                </div>
                {(providers.length > 0 || directions.some(([direction]) => !['inbound', 'outbound'].includes(direction))) &&
                    <p className="analytics-calls-note">Провайдеры: {providers.map(([provider, count]) => `${provider || 'Не указан'} — ${count}`).join(', ') || 'не указаны'}.
                        {directions.some(([direction]) => !['inbound', 'outbound'].includes(direction)) ? ' В общем числе есть вызовы без направления.' : ''}</p>}
                <p className="analytics-calls-note">Показатели основаны на сохранённой истории звонков, а не на текущих активных каналах или оценке выручки.</p>
            </>}
        </div>
    </section>;
}

// ═══════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════

export default function Analytics() {
    const { currentInstanceId } = useInstance();
    const access = useBusinessAccess();
    return <ScopedAnalytics key={`${currentInstanceId}:${access.userId}:${access.role}`} />;
}

function ScopedAnalytics() {
    const { role } = useAuth();
    const access = useBusinessAccess();
    const { instances, currentInstanceId } = useInstance();
    const currentInstance = instances.find(i => i.id === currentInstanceId);
    const isCoffeePickup = isCoffeeBusiness(currentInstance);
    const funnelStatuses = isCoffeePickup ? COFFEE_FUNNEL_ORDER : SALES_FUNNEL_ORDER;
    const statusLabels = Object.fromEntries(
        getPipeline(currentInstance).map(status => [status.id, status.label])
    ) as Record<string, string>;

    const [funnelData, setFunnelData] = useState<FunnelData | null>(null);
    const [avgTimeData, setAvgTimeData] = useState<AvgTimeData | null>(null);
    const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
    const [msgOverTime, setMsgOverTime] = useState<MsgDay[]>([]);
    const [channels, setChannels] = useState<ChannelRow[]>([]);
    const [responseTime, setResponseTime] = useState<ResponseTimeData | null>(null);
    const [summary, setSummary] = useState<SmartSummary | null>(null);
    const [leadsOverTime, setLeadsOverTime] = useState<LeadDay[]>([]);
    const [forecast, setForecast] = useState<DealSummary | null>(null);
    const [callData, setCallData] = useState<CallAnalyticsResponse | null>(null);
    const [callDays, setCallDays] = usePeriod();
    const [callLoading, setCallLoading] = useState(Boolean(currentInstanceId));
    const [callError, setCallError] = useState('');
    const [callRevision, setCallRevision] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState<string[]>([]);
    const msgDays = callDays;
    const setMsgDays = setCallDays;
    const requestId = useRef(0);

    const fetchAll = useCallback(async () => {
        if (!currentInstanceId) return;
        const request = ++requestId.current;
        setLoading(true);
        setError(null);
        setUnavailable([]);
        try {
            const results = await Promise.allSettled([
                getAnalyticsFunnel(currentInstanceId),
                getAnalyticsAvgTime(currentInstanceId),
                getAnalyticsHeatmap(currentInstanceId),
                getAnalyticsMessagesOverTime(currentInstanceId, msgDays),
                getAnalyticsChannelBreakdown(currentInstanceId),
                getAnalyticsResponseTimes(currentInstanceId),
                getAnalyticsSmartSummary(currentInstanceId),
                getAnalyticsLeadsOverTime(currentInstanceId, msgDays),
                getRevenueForecast(currentInstanceId),
            ]);
            if (request !== requestId.current) return;
            const values = results.map(result => result.status === 'fulfilled' ? result.value : null);
            const sources = ['funnel', 'time', 'heatmap', 'messages', 'channels', 'response', 'summary', 'leads', 'deals'];
            const failedSources = results.flatMap((result, index) => result.status === 'rejected' || !result.value?.success ? [sources[index]] : []);
            setUnavailable(failedSources);
            const [fRes, tRes, hRes, mRes, cRes, rRes, sRes, lRes, fcRes] = values;
            if (fRes?.success) setFunnelData(fRes);
            if (tRes?.success) setAvgTimeData(tRes);
            if (hRes?.success) setHeatmap(hRes.heatmap || []);
            if (mRes?.success) setMsgOverTime(mRes.data || []);
            if (cRes?.success) setChannels(cRes.channels || []);
            if (rRes?.success) setResponseTime(rRes.responseTime || null);
            if (sRes?.success) setSummary(sRes.summary || null);
            if (lRes?.success) setLeadsOverTime(lRes.data || []);
            if (fcRes?.success && fcRes.forecast?.source === 'customer_deals') setForecast(fcRes.forecast as DealSummary);
            if (failedSources.length > 0) {
                setError('Часть показателей не удалось обновить. Ниже сохранены последние полученные значения; нажмите «Обновить» для повторной проверки.');
            }
        } catch (e: unknown) {
            if (request === requestId.current) setError(e instanceof Error ? e.message : 'Ошибка загрузки данных');
        } finally {
            if (request === requestId.current) setLoading(false);
        }
    }, [currentInstanceId, msgDays]);

    useEffect(() => { void fetchAll(); return () => { requestId.current += 1; }; }, [fetchAll]);
    useEffect(() => {
        if (!currentInstanceId) { setCallData(null); return; }
        let active = true;
        setCallData(null); setCallError(''); setCallLoading(true);
        void getCallAnalytics(currentInstanceId, callDays).then((result: CallAnalyticsResponse) => {
            if (!active) return;
            if (!result?.success || Number(result.business_id) !== currentInstanceId || result.period_days !== callDays || !result.stats) {
                throw new Error('CALL_ANALYTICS_SCOPE_MISMATCH');
            }
            setCallData(result);
        }).catch(() => {
            if (active) setCallError('Не удалось загрузить статистику звонков. История и другие показатели остаются доступны; нажмите «Обновить».');
        }).finally(() => { if (active) setCallLoading(false); });
        return () => { active = false; };
    }, [currentInstanceId, callDays, callRevision]);

    if (!currentInstance) {
        return (
            <div className="analytics-page analytics-empty flex flex-col items-center justify-center h-full text-center">
                <AlertCircle size={40} className="text-[#8b8fa3] mb-4" />
                <h2 className="text-xl font-bold text-white mb-2">Нет активного бизнеса</h2>
                <p className="text-[#8b8fa3]">Создайте первый бизнес в разделе «Бизнесы»</p>
                <Link to="/instances" className="analytics-deals-link mt-4">Открыть бизнесы</Link>
            </div>
        );
    }

    return (
        <div className="analytics-page max-w-6xl mx-auto pb-10">
            {/* Header */}
            <div id="analytics-overview" className="flex items-center justify-between mb-6">
                <div>
                    <p className="analytics-eyebrow">AVA · Данные бизнеса</p>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-3">Аналитика</h1>
                    <p className="text-[#8b8fa3] mt-1 text-sm">
                        Клиенты, сообщения и воронка · <span className="font-semibold">{currentInstance.name}</span>
                    </p>
                </div>
                <button type="button" onClick={() => { void fetchAll(); setCallRevision(value => value + 1); }} disabled={loading || callLoading}
                    className="flex items-center gap-2 text-sm text-[#8b8fa3] hover:text-white transition-colors px-3 py-2 rounded-lg hover:bg-[#22262f]">
                    <RefreshCw size={15} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> {loading ? 'Обновляем…' : 'Обновить'}
                </button>
            </div>

            <nav className="analytics-nav" aria-label="Разделы аналитики">
                <a href="#analytics-overview">Обзор</a>
                <a href="#analytics-messages">Сообщения</a>
                <a href="#analytics-calls">Звонки</a>
                <a href="#analytics-funnel">Воронка</a>
                <a href="#analytics-export">Экспорт</a>
            </nav>

            {error && (
                <div className="analytics-error mb-6 p-4 text-sm flex items-center gap-2" role="alert">
                    <AlertCircle size={16} /> {error}
                </div>
            )}

            {role !== 'platform_admin' && currentInstanceId && (access.can('ai.use')
                ? <p className="analytics-knowledge-link"><Link to="/knowledge-base#answer-improvements">Улучшить ответы AVA по вопросам клиентов →</Link></p>
                : <KnowledgeReview businessId={currentInstanceId} collapsed />)}

            {/* ─── KPI CARDS ─── */}
            {summary && (
                <div className="analytics-kpis grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                    <KpiCard icon={<Users size={16} className="text-blue-400" />} label="Клиентов всего" value={summary.totalClients}
                        sub={`${summary.thisWeekLeads} за последние 7 дней`} href="/clients?view=all" />
                    <KpiCard icon={<Target size={16} className="text-green-400" />} label="Доля успешных клиентов" value={`${summary.conversionRate}%`}
                        sub={`${summary.bookedClients} ${isCoffeePickup ? 'самовывозов подтверждено' : 'записано'}`} href={`/clients?view=all&status=${isCoffeePickup ? 'pickup_confirmed&status=ready_for_pickup' : 'booked'}`} />
                    <KpiCard icon={<MessageSquare size={16} className="text-purple-400" />} label="Сообщений сегодня" value={summary.msgsToday} sub="По календарю источника" href="/reports?type=messages&days=7" />
                    <KpiCard icon={<Timer size={16} className="text-amber-400" />} label="Среднее время ответа · 30 дней"
                        value={responseTime && responseTime.totalSamples > 0 ? fmtSeconds(responseTime.avgSeconds) : '—'}
                        sub={responseTime ? `${responseTime.totalSamples} ответов` : unavailable.includes('response') ? 'Данные недоступны' : 'Нет измерений'} href="#analytics-response" />
                </div>
            )}
            {loading && !summary && <p className="analytics-loading" role="status">Загружаем показатели выбранного бизнеса…</p>}
            {!loading && !summary && <p className="analytics-empty" role="status">Сводка пока недоступна. Проверьте подключение и нажмите «Обновить».</p>}

            {leadsOverTime.length > 1 && <LeadOutcomesCard data={leadsOverTime} isCoffee={isCoffeePickup} />}
            {!loading && unavailable.includes('leads') && <p className="analytics-empty" role="status">Динамика лидов недоступна. Остальные показатели можно просмотреть ниже.</p>}

            {/* ─── ROW: AI Insights + Mini Stats ─── */}
            {summary && (
                <div className="mb-6">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="analytics-mini-card">
                            <div className="flex items-center gap-2 mb-2">
                                <Activity size={14} className="text-green-400" />
                                <span className="text-xs text-[#8b8fa3]">Активные лиды</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-xl font-bold text-green-400">{summary.activeLeads}</span>
                                <span className="text-xs text-[#6b6f80]">писали {'<'}3 дн</span>
                            </div>
                        </div>
                        <div className="analytics-mini-card">
                            <div className="flex items-center gap-2 mb-2">
                                <Flame size={14} className="text-red-400" />
                                <span className="text-xs text-[#8b8fa3]">Остывают</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-xl font-bold text-red-400">{summary.staleLeads}</span>
                                <span className="text-xs text-[#6b6f80]">молчат {'>'}3 дн</span>
                            </div>
                        </div>
                        <div className="analytics-mini-card">
                            <div className="flex items-center gap-2 mb-2">
                                <Zap size={14} className="text-amber-400" />
                                <span className="text-xs text-[#8b8fa3]">Автоматизация</span>
                            </div>
                            <div className="flex items-center gap-4">
                                <div>
                                    <span className="text-lg font-bold text-amber-400">{summary.triggersExecuted}</span>
                                    <span className="text-[10px] text-[#6b6f80] ml-1">триггеров</span>
                                </div>
                                <div>
                                    <span className="text-lg font-bold text-blue-400">{summary.activeSequences}</span>
                                    <span className="text-[10px] text-[#6b6f80] ml-1">в цепочках</span>
                                </div>
                            </div>
                        </div>
                        {/* Leads sparkline */}
                        {leadsOverTime.length > 1 && (
                            <div className="analytics-mini-card">
                                <div className="flex items-center gap-2 mb-2">
                                    <TrendingUp size={14} className="text-[#00c2ff]" />
                                    <span className="text-xs text-[#8b8fa3]">Новые лиды (30 дн)</span>
                                </div>
                                <LeadsSparkline data={leadsOverTime} />
                            </div>
                        )}
                    </div>
                </div>
            )}

            <CallAnalytics data={callData} days={callDays} onDaysChange={setCallDays} loading={callLoading} error={callError} />

            {/* ─── Messages Over Time ─── */}
            <div id="analytics-messages" className="card mb-6">
                <div className="card-header flex items-center gap-2">
                    <Hash size={18} className="text-blue-400" />
                    <h3 className="font-semibold text-white">Сообщения по дням</h3>
                    <div className="ml-auto flex gap-1">
                        {[7, 14, 30, 90].map(d => (
                            <button key={d} type="button" aria-pressed={msgDays === d} aria-label={`Показать сообщения за ${d} дней`} onClick={() => setMsgDays(d)}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium ${msgDays === d ? 'bg-blue-500/20 text-blue-400' : 'text-[#6b6f80] hover:text-[#8b8fa3]'}`}>
                                {d}д
                            </button>
                        ))}
                    </div>
                </div>
                    <div className="card-body">
                        {loading ? <p className="analytics-loading" role="status">Загружаем сообщения…</p> : unavailable.includes('messages') ? <p className="analytics-empty" role="status">Данные сообщений недоступны.</p> : <MessagesChart data={msgOverTime} />}
                </div>
            </div>

            {/* ─── ROW: Heatmap + Channels + Response Time ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                {/* Heatmap — 2 cols */}
                <div className="lg:col-span-2 card">
                    <div className="card-header flex items-center gap-2">
                        <Activity size={18} className="text-[#00c2ff]" />
                        <h3 className="font-semibold text-white">Тепловая карта активности</h3>
                        <span className="text-[10px] text-[#6b6f80] ml-auto">Когда клиенты пишут</span>
                    </div>
                    <div className="card-body">
                        {loading ? <p className="analytics-loading" role="status">Загружаем активность…</p> : unavailable.includes('heatmap') ? <p className="analytics-empty" role="status">Данные активности недоступны.</p> : <ActivityHeatmap data={heatmap} />}
                    </div>
                </div>

                {/* Channels + Response Time */}
                <div className="space-y-4">
                    <div className="card">
                        <div className="card-header flex items-center gap-2">
                            <MessageSquare size={16} className="text-[#00c2ff]" />
                            <h3 className="font-semibold text-white text-sm">Каналы</h3>
                        </div>
                        <div className="card-body">
                            {loading ? <p className="analytics-loading" role="status">Загружаем каналы…</p> : unavailable.includes('channels') ? <p className="analytics-empty" role="status">Данные каналов недоступны.</p> : <ChannelBreakdown data={channels} />}
                        </div>
                    </div>
                    <div className="card">
                        <div className="card-header flex items-center gap-2">
                            <Timer size={16} className="text-amber-400" />
                            <h3 className="font-semibold text-white text-sm">Скорость ответа</h3>
                        </div>
                        <div className="card-body">
                            {responseTime && responseTime.totalSamples > 0 ? <div id="analytics-response"><ResponseTimeGauge data={responseTime} /></div> : <p className="text-sm text-[#8b8fa3] text-center py-4">{loading ? 'Загрузка...' : unavailable.includes('response') ? 'Данные времени ответа недоступны' : 'За 30 дней измерений пока нет'}</p>}
                        </div>
                    </div>
                </div>
            </div>

            {/* ─── Conversion Funnel ─── */}
            <div id="analytics-funnel" className="card mb-6">
                <div className="card-header flex items-center gap-2">
                    <TrendingDown size={18} className="text-[#00c2ff]" />
                    <h3 className="font-semibold text-white">Воронка конверсий</h3>
                    <span className="text-xs text-[#8b8fa3] ml-auto">Переходы между этапами</span>
                </div>
                <div className="card-body">
                    {loading && !funnelData ? (
                        <div className="flex items-center justify-center h-40 text-[#8b8fa3]"><RefreshCw className="animate-spin mr-2" size={18} /> Загрузка...</div>
                    ) : funnelData ? (
                        <>
                            {funnelData.bottleneck && funnelData.bottleneck.totalFromStatus > 0 && (
                                <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-sm">
                                    <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
                                    <div>
                                        <span className="text-red-400 font-semibold">Узкое место: </span>
                                        <span className="text-[#e4e6eb]">{statusLabels[funnelData.bottleneck.from]} → {statusLabels[funnelData.bottleneck.to]}: {funnelData.bottleneck.dropRate}% не идут дальше</span>
                                    </div>
                                </div>
                            )}
                            <SankeyFunnel data={funnelData} statuses={funnelStatuses} labels={statusLabels} />
                            {funnelData.holes.length > 0 && (
                                <div className="mt-6">
                                    <h4 className="text-sm font-medium text-[#8b8fa3] mb-3">Детализация переходов</h4>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-[#8b8fa3] text-xs border-b border-[#2a2e3a]">
                                                    <th className="text-left pb-2 font-medium">Переход</th>
                                                    <th className="text-right pb-2 font-medium">Прошло</th>
                                                    <th className="text-right pb-2 font-medium">Всего</th>
                                                    <th className="text-right pb-2 font-medium">Отток</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {funnelData.holes.map((h, i) => {
                                                    const isWorst = funnelData.bottleneck?.from === h.from;
                                                    return (
                                                        <tr key={i} className={`border-b border-[#1a1d26] ${isWorst ? 'bg-red-500/5' : ''}`}>
                                                            <td className="py-2.5">
                                                                <span className="text-[#e4e6eb]">{statusLabels[h.from] || STATUS_LABELS[h.from]}</span>
                                                                <span className="text-[#8b8fa3] mx-1.5">→</span>
                                                                <span className="text-[#e4e6eb]">{statusLabels[h.to] || STATUS_LABELS[h.to]}</span>
                                                                {isWorst && <span className="text-[10px] text-red-400 ml-1.5">Узкое место</span>}
                                                            </td>
                                                            <td className="py-2.5 text-right text-[#00c2ff] font-medium">{h.advancedCount}</td>
                                                            <td className="py-2.5 text-right text-[#8b8fa3]">{h.totalFromStatus}</td>
                                                            <td className="py-2.5 text-right">
                                                                <span className={`font-bold ${h.dropRate > 50 ? 'text-red-400' : h.dropRate > 25 ? 'text-amber-400' : 'text-[#8b8fa3]'}`}>{h.dropRate}%</span>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                            {funnelData.transitions.length === 0 && <div className="text-center py-8 text-[#8b8fa3] text-sm">Данные появятся по мере работы с лидами</div>}
                        </>
                    ) : <p className="analytics-empty" role="status">{unavailable.includes('funnel') ? 'Не удалось получить данные воронки.' : 'Данных воронки пока нет.'}</p>}
                </div>
            </div>

            {/* ─── VERIFIED DEAL TOTALS ─── */}
            {forecast && (
                <section className="card mb-6 analytics-deals" aria-labelledby="analytics-deals-title">
                    <div className="card-header flex items-center gap-2">
                        <Wallet size={18} aria-hidden="true" />
                        <div>
                            <h3 id="analytics-deals-title" className="font-semibold">Сделки и платежи</h3>
                            <p className="analytics-deals-note">Суммы из сделок AVA, без вероятностей и конвертации валют. Это не прогноз поступлений.</p>
                        </div>
                        <Link className="analytics-deals-link" to="/deals">Все сделки</Link>
                    </div>
                    <div className="card-body">
                        <div className="analytics-deals-summary" aria-label="Сводка по сделкам">
                            <Link to="/deals?state=open&mine=0"><span>Открытых сделок</span><strong>{forecast.activeDeals}</strong></Link>
                            <Link to="/deals?stage=won&mine=0"><span>Выигранных сделок</span><strong>{forecast.completedDeals}</strong></Link>
                            <div><a href="#analytics-payments"><span>Успешные платежи YooKassa</span><strong>{formatDealAmount(forecast.succeededPaymentsRUB, 'RUB')}</strong></a><small>Только зарегистрированные платежи YooKassa.</small></div>
                        </div>
                        {forecast.amountsByCurrency.length > 0 ? <div className="analytics-deals-currencies" aria-label="Суммы сделок по валютам">
                            {forecast.amountsByCurrency.map(row => <div key={row.currency} className="analytics-deals-currency">
                                <b>{row.currency}</b>
                                <Link to={`/deals?state=open&currency=${row.currency}&mine=0`}><span>Открытые · {row.openDeals}</span><strong>{formatDealAmount(row.openAmount, row.currency)}</strong></Link>
                                <Link to={`/deals?stage=won&currency=${row.currency}&mine=0`}><span>Выигранные · {row.wonDeals}</span><strong>{formatDealAmount(row.wonAmount, row.currency)}</strong></Link>
                            </div>)}
                        </div> : <p className="analytics-deals-note">Сделок пока нет. Создайте первую сделку, чтобы увидеть суммы и этапы.</p>}
                        {currentInstanceId && <PaymentSources key={currentInstanceId} businessId={currentInstanceId} />}
                        {forecast.deals.length > 0 && <div className="overflow-x-auto analytics-deals-table"><table>
                            <thead><tr><th scope="col">Сделка</th><th scope="col">Клиент</th><th scope="col">Этап</th><th scope="col">Следующее действие</th><th scope="col">Сумма</th></tr></thead>
                            <tbody>{forecast.deals.map(deal => <tr key={deal.id}>
                                <td><Link to={`/deals?dealId=${encodeURIComponent(deal.id)}&mine=0`}>{deal.title}</Link></td>
                                <td>{deal.chatId ? <Link to={`/customers/${encodeURIComponent(deal.chatId)}`}>{deal.clientName || deal.chatId}</Link> : 'Не привязан'}</td>
                                <td>{DEAL_STAGE_LABELS[deal.stage] || deal.stage}</td>
                                <td>{deal.nextActionAt || 'Не назначено'}</td>
                                <td>{formatDealAmount(deal.amount, deal.currency)}</td>
                            </tr>)}</tbody>
                        </table></div>}
                    </div>
                </section>
            )}
            {!loading && unavailable.includes('deals') && <p className="analytics-empty" role="status">Сводка по сделкам и платежам недоступна. <Link to="/deals">Открыть сделки</Link></p>}

            {/* ─── ROW: Avg Time + Export ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="card">
                    <div className="card-header flex items-center gap-2">
                        <Clock size={18} className="text-[#f59e0b]" />
                        <h3 className="font-semibold text-white">Время в статусе</h3>
                    </div>
                    <div className="card-body">
                        {avgTimeData ? (
                            <>
                                {avgTimeData.bottleneck && avgTimeData.bottleneck.avgHours >= 12 && (
                                    <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-start gap-2 text-sm">
                                        <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                                        <span className="text-[#e4e6eb] text-xs">
                                            Обращения застревают в «{statusLabels[avgTimeData.bottleneck.status] || STATUS_LABELS[avgTimeData.bottleneck.status]}» на {fmtTime(avgTimeData.bottleneck.avgHours)}
                                        </span>
                                    </div>
                                )}
                                <AvgTimeChart data={avgTimeData.data} bottleneck={avgTimeData.bottleneck} statuses={funnelStatuses} labels={statusLabels} />
                            </>
                        ) : <div className="text-center py-8 text-[#8b8fa3] text-sm">{loading ? 'Загрузка...' : unavailable.includes('time') ? 'Данные времени в статусе недоступны' : 'Данных о времени в статусе пока нет'}</div>}
                    </div>
                </div>

                <div id="analytics-export" className="card">
                    <div className="card-header flex items-center gap-2">
                        <Download size={18} className="text-[#3b82f6]" />
                        <h3 className="font-semibold text-white">Экспорт лидов</h3>
                    </div>
                    <div className="card-body">
                        <ExportPanel instanceId={currentInstanceId!} />
                    </div>
                </div>
            </div>
        </div>
    );
}


type Payment = { id: number; instanceId: number; chatId: string; amount: number; status: string; description?: string; createdAt?: string };
function PaymentSources({ businessId }: { businessId: number }) {
    const [open, setOpen] = useState(false), [rows, setRows] = useState<Payment[] | null>(null);
    const [error, setError] = useState(''), [revision, setRevision] = useState(0), [limit, setLimit] = useState(20);
    useEffect(() => {
        if (!open) return;
        let active = true; setError('');
        void getPayments(businessId).then((result: { success: boolean; payments: Payment[] }) => {
            if (!result.success || !Array.isArray(result.payments) || result.payments.some(row => row.instanceId !== businessId || !Number.isFinite(row.amount))) throw new Error();
            if (active) setRows(result.payments.filter(row => row.status === 'succeeded'));
        }).catch(() => { if (active) setError('Не удалось получить платежи. Сумма выше не заменяет проверку отдельных платежей.'); });
        return () => { active = false; };
    }, [businessId, open, revision]);
    return <details id="analytics-payments" className="analytics-data-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>Какие платежи вошли в сумму</summary>
        {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Повторить</button></p>}
        {!rows && !error && open && <p role="status">Получаем подтверждённые платежи…</p>}
        {rows && <><p>Успешные платежи за всю историю: {rows.length} · {formatDealAmount(rows.reduce((sum, row) => sum + row.amount, 0), 'RUB')}. Сводка выше могла быть получена раньше.</p>
            <ul>{rows.slice(0, limit).map(row => <li key={row.id}><Link to={`/customers/${encodeURIComponent(row.chatId)}`}>{row.description || 'Платёж клиента'}</Link> · {formatDealAmount(row.amount, 'RUB')}{row.createdAt ? ` · ${row.createdAt.slice(0, 10)}` : ''}</li>)}</ul>
            {rows.length > limit && <button type="button" onClick={() => setLimit(value => value + 20)}>Показать ещё</button>}
        </>}
    </details>;
}
