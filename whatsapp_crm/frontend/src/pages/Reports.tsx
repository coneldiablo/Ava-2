import { useEffect, useRef, useState } from 'react';
import { Download, FileBarChart2, RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { getWorkspaceAnalytics, stageLabel, type WorkspaceAnalyticsResponse } from '../avaWorkspace';
import { getAnalyticsExportUrl, getAnalyticsLeadsOverTime, getAnalyticsMessagesOverTime, getCallAnalytics } from '../api';
import { useInstance } from '../context/InstanceContext';
import './Reports.css';

type ReportType = 'leads' | 'messages' | 'calls' | 'deals';
type Period = 7 | 30 | 90;
type LeadRow = { date: string; count: number; successTransitions: number };
type MessageRow = { date: string; incoming: number; outgoing: number; total: number };
type CallStats = { total_calls: number; avg_duration_seconds: number; directions: Record<string, number>; calls_per_day: { date: string; count: number }[] };
type ReportData = { type: 'deals'; stats: WorkspaceAnalyticsResponse } | { type: 'leads'; rows: LeadRow[] } | { type: 'messages'; rows: MessageRow[] } | { type: 'calls'; stats: CallStats };

const REPORTS: { value: ReportType; label: string; description: string }[] = [
    { value: 'deals', label: 'Сделки', description: 'Этапы сделок и подтверждённая история закрытий' },
    { value: 'leads', label: 'Клиенты', description: 'Новые лиды и первые успешные переходы по дням' },
    { value: 'messages', label: 'Сообщения', description: 'Входящие и исходящие сообщения по дням' },
    { value: 'calls', label: 'Звонки', description: 'Сохранённые вызовы AVA по дням (UTC)' },
];

function count(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function validCount(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function dateDaysAgo(days: Period): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days + 1);
    return date.toISOString().slice(0, 10);
}

export default function Reports() {
    const { currentInstanceId, currentInstance } = useInstance();
    return <ScopedReports key={currentInstanceId ?? 'none'} businessId={currentInstanceId} businessName={currentInstance?.name || ''} />;
}

function ScopedReports({ businessId, businessName }: { businessId: number | null; businessName: string }) {
    const [params, setParams] = useSearchParams();
    const type: ReportType = REPORTS.some(report => report.value === params.get('type')) ? params.get('type') as ReportType : 'leads';
    const days: Period = [7, 30, 90].includes(Number(params.get('days'))) ? Number(params.get('days')) as Period : 30;
    const metric = params.get('metric') || '';
    const latestParams = useRef(params);
    useEffect(() => { latestParams.current = params; }, [params]);
    function updateParams(change: (next: URLSearchParams) => void) {
        const next = new URLSearchParams(latestParams.current);
        change(next); latestParams.current = next; setParams(next);
    }
    function setType(value: ReportType) { updateParams(next => { next.set('type', value); next.delete('metric'); }); }
    function setDays(value: Period) { updateParams(next => { next.set('days', String(value)); }); }
    const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
    const [revision, setRevision] = useState(0);
    const [data, setData] = useState<ReportData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
    const [exporting, setExporting] = useState(false);
    const [exportError, setExportError] = useState('');

    useEffect(() => {
        let active = true;
        setData(null);
        setError('');
        setUpdatedAt(null);
        setExportError('');
        if (!businessId) { setLoading(false); return () => { active = false; }; }
        setLoading(true);
        const request = type === 'deals' ? getWorkspaceAnalytics(businessId, days) : type === 'leads' ? getAnalyticsLeadsOverTime(businessId, days)
            : type === 'messages' ? getAnalyticsMessagesOverTime(businessId, days)
                : getCallAnalytics(businessId, days);
        request.then((response: unknown) => {
            if (!active) return;
            const result = response as Record<string, unknown>;
            if (result.success !== true) throw new Error('Не удалось получить отчёт.');
            if (type === 'deals') {
                if (result.businessId !== businessId || !result.metrics || typeof result.metrics !== 'object') throw new Error('Ответ не соответствует выбранному бизнесу.');
                setData({ type, stats: result as unknown as WorkspaceAnalyticsResponse });
            } else if (type === 'calls') {
                if (Number(result.business_id) !== businessId || Number(result.period_days) !== days
                    || !result.stats || typeof result.stats !== 'object') throw new Error('Ответ не соответствует выбранному бизнесу.');
                const stats = result.stats as CallStats;
                if (!validCount(stats.total_calls) || !stats.directions || typeof stats.directions !== 'object'
                    || Object.values(stats.directions).some(value => !validCount(value)) || !Array.isArray(stats.calls_per_day)
                    || !stats.calls_per_day.every(row => typeof row.date === 'string' && validCount(row.count))) throw new Error('Некорректные данные отчёта.');
                setData({ type, stats });
            } else {
                if (!Array.isArray(result.data) || !result.data.every((row: LeadRow | MessageRow) =>
                    typeof row.date === 'string' && (type === 'leads'
                        ? validCount((row as LeadRow).count) && validCount((row as LeadRow).successTransitions)
                        : validCount((row as MessageRow).incoming) && validCount((row as MessageRow).outgoing)))) {
                    throw new Error('Некорректные данные отчёта.');
                }
                setData({ type, rows: result.data as LeadRow[] & MessageRow[] });
            }
            setUpdatedAt(new Date());
        }).catch((cause: unknown) => {
            if (active) setError((cause as { response?: { status?: number } })?.response?.status === 403
                ? 'Нет доступа к отчётам этого бизнеса.'
                : cause instanceof Error && cause.message.startsWith('Ответ не соответствует') ? cause.message
                    : 'Не удалось загрузить отчёт. Попробуйте обновить страницу.');
        }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [businessId, type, days, revision]);

    const download = async () => {
        if (!businessId || type !== 'leads' || loading || error || !data || exporting) return;
        setExporting(true);
        setExportError('');
        const url = getAnalyticsExportUrl(businessId, format, dateDaysAgo(days), new Date().toISOString().slice(0, 10));
        try {
            const response = await fetch(url, { credentials: 'same-origin' });
            if (!response.ok) throw new Error('EXPORT_FAILED');
            const contentType = response.headers.get('content-type') || '';
            if (!(format === 'csv' ? contentType.includes('text/csv') : contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))) {
                throw new Error('EXPORT_TYPE_MISMATCH');
            }
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = `leads_${businessId}.${format}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        } catch {
            setExportError('Не удалось скачать выгрузку. Попробуйте ещё раз.');
        } finally {
            setExporting(false);
        }
    };

    const selected = REPORTS.find(report => report.value === type)!;
    const leadRows = data?.type === 'leads' ? data.rows : [];
    const messageRows = data?.type === 'messages' ? data.rows : [];
    const callStats = data?.type === 'calls' ? data.stats : null;
    const dealStats = data?.type === 'deals' ? data.stats : null;
    const dealRows = dealStats ? Array.isArray(dealStats.metrics.stageCounts) ? dealStats.metrics.stageCounts : Object.entries(dealStats.metrics.stageCounts).map(([stage, count]) => ({ stage, count })) : [];
    const rows = data?.type === 'deals' ? dealRows.map(row => ({ date: stageLabel(row.stage), first: row.count, second: null })) : data?.type === 'leads' ? leadRows.map(row => ({ date: row.date, first: count(row.count), second: count(row.successTransitions) }))
        : data?.type === 'messages' ? messageRows.map(row => ({ date: row.date, first: count(row.incoming), second: count(row.outgoing) }))
            : (callStats?.calls_per_day || []).map(row => ({ date: row.date, first: count(row.count), second: null }));
    const cards = data?.type === 'deals' ? dealRows.map(row => ({ label: stageLabel(row.stage), value: row.count, href: `/deals?stage=${encodeURIComponent(row.stage)}&mine=0` })) : data?.type === 'leads'
        ? [{ label: 'Новые лиды', value: leadRows.reduce((sum, row) => sum + count(row.count), 0) },
            { label: 'Первые успешные переходы', value: leadRows.reduce((sum, row) => sum + count(row.successTransitions), 0) }]
        : data?.type === 'messages'
            ? [{ label: 'Входящие', value: messageRows.reduce((sum, row) => sum + count(row.incoming), 0) },
                { label: 'Исходящие', value: messageRows.reduce((sum, row) => sum + count(row.outgoing), 0) }]
            : data?.type === 'calls' && callStats
                ? [{ label: 'Всего звонков', value: count(callStats.total_calls) },
                    { label: 'Входящие', value: count(callStats.directions?.inbound) },
                    { label: 'Исходящие', value: count(callStats.directions?.outbound) }]
                : [];

    return <div className="reports-page">
        <header className="reports-heading">
            <div><p className="reports-eyebrow">AVA · ДАННЫЕ БИЗНЕСА</p><h1>Отчёты</h1>
                <p>Реальные показатели {businessName ? `бизнеса «${businessName}»` : 'выбранного бизнеса'} за выбранный период.</p></div>
            <button type="button" className="reports-refresh" onClick={() => setRevision(value => value + 1)} disabled={!businessId || loading}>
                <RefreshCw size={17} aria-hidden="true" /> Обновить
            </button>
        </header>
        <nav className="reports-nav" aria-label="Связанные разделы"><Link to="/analytics">Обзор аналитики</Link><Link to="/activity">Активность</Link><Link to="/calls">Журнал звонков</Link></nav>
        {!businessId ? <p className="reports-state" role="status">Сначала выберите бизнес. <Link to="/instances">Открыть список бизнесов</Link></p> : <>
            <section className="reports-controls" aria-label="Параметры отчёта">
                <div className="reports-type-picker" role="group" aria-label="Тип отчёта">{REPORTS.map(report => <button type="button" key={report.value} aria-pressed={type === report.value} onClick={() => setType(report.value)}><strong>{report.label}</strong><span>{report.description}</span></button>)}</div>
                <div><label htmlFor="reports-period">Период</label><select id="reports-period" value={days} onChange={event => setDays(Number(event.target.value) as Period)}>
                    {[7, 30, 90].map(value => <option key={value} value={value}>Последние {value} дней</option>)}
                </select></div>
            </section>
            <section className="reports-result" aria-labelledby="reports-result-title">
                <div className="reports-result-heading"><FileBarChart2 size={20} aria-hidden="true" /><div><h2 id="reports-result-title">{selected.label} · последние {days} дней</h2><p>{selected.description}{updatedAt ? ` · получено в ${updatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}</p></div></div>
                {loading && <p className="reports-state" role="status">Загружаем данные…</p>}
                {!loading && error && <p className="reports-state reports-error" role="alert">{error}</p>}
                {!loading && !error && data && <>
                    <div className="reports-kpis">{cards.map((card, index) => <Link to={'href' in card ? card.href : `?type=${type}&days=${days}&metric=${index === 0 ? 'first' : 'second'}#reports-table`} key={card.label}><span>{card.label}</span><strong>{card.value.toLocaleString('ru-RU')}</strong></Link>)}</div>
                    {rows.length ? <div id="reports-table" className="reports-table-wrap"><table><caption>{type === 'deals' ? 'Текущее состояние сделок' : 'Показатели по дням'}</caption><thead><tr><th scope="col">{type === 'deals' ? 'Этап' : 'Дата'}</th>
                        <th scope="col">{type === 'deals' ? 'Сделки' : type === 'leads' ? 'Новые клиенты' : type === 'messages' ? 'Входящие' : 'Звонки'}</th>
                        {type !== 'calls' && type !== 'deals' && <th scope="col">{type === 'leads' ? 'Первые успешные переходы' : 'Исходящие'}</th>}
                    </tr></thead><tbody>{rows.filter(row => metric === 'first' ? row.first > 0 : metric === 'second' ? (row.second || 0) > 0 : true).map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.first}</td>{row.second !== null && <td>{row.second}</td>}</tr>)}</tbody></table></div>
                        : <p className="reports-state">За выбранный период записей нет.</p>}
                    {type === 'leads' && <div className="reports-export"><div><strong>Выгрузка лидов</strong><p>Файл содержит данные клиентов и историю статусов. Храните его безопасно.</p></div>
                        <label htmlFor="reports-format">Формат</label><select id="reports-format" value={format} onChange={event => setFormat(event.target.value as 'csv' | 'xlsx')}>
                            <option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option></select>
                        <button type="button" onClick={() => { void download(); }} disabled={exporting}><Download size={17} aria-hidden="true" /> {exporting ? 'Готовим файл…' : 'Скачать'}</button></div>}
                    {exportError && <p className="reports-note reports-error" role="alert">{exportError}</p>}
                    {dealStats && <dl className="reports-method"><div><dt>Успешные закрытия за {days} дней</dt><dd>{dealStats.metrics.winRate == null ? 'Нет измерений' : `${dealStats.metrics.winRate.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`}</dd></div><div><dt>Средний цикл закрытых сделок</dt><dd>{dealStats.metrics.averageCycleDays == null ? 'Нет измерений' : `${dealStats.metrics.averageCycleDays.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} дн.`}</dd></div><div><dt>Закрытых сделок с полной историей</dt><dd>{dealStats.metrics.closedSampleSize ?? 'Не указано'}</dd></div></dl>}
                    {type === 'deals' && <p className="reports-note">Этапы показывают текущее состояние; доля закрытий и цикл за {days} дней рассчитываются из сохранённой истории. Суммы сделок не означают оплату. <Link to={`/workspace-analytics?days=${days}`}>Открыть работу команды и методику</Link></p>}
                    {type === 'messages' && <p className="reports-note">Для сообщений доступен просмотр. Экспорт этого типа отчёта пока не поддерживается.</p>}
                    {type === 'calls' && <p className="reports-note">Данные основаны на сохранённой истории звонков. Если сервис звонков недоступен, показатели не подменяются оценками. Экспорт пока не поддерживается.</p>}
                </>}
            </section>
        </>}
    </div>;
}
