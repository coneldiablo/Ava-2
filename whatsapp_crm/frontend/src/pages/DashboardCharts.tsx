import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DashboardMetrics } from './dashboardApi';

const number = new Intl.NumberFormat('ru-RU');
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const dateLabel = (value: string) => /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(`${value}T12:00:00Z`)) : 'Дата не указана';
const readable = (value: number | null) => value === null ? 'нет данных' : number.format(value);

/** One real daily series per line; a missing source is a gap, never a zero. */
export function BusinessTrend({ metrics, fallback }: { metrics: DashboardMetrics | null; fallback: string }) {
    const uid = useId();
    const [visible, setVisible] = useState({ leads: true, won: true });
    const [selected, setSelected] = useState(0);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [width, setWidth] = useState(700);
    const leads = metrics?.series.leads ?? [], wins = metrics?.series.closedDeals ?? [];
    const dates = [...new Set([...leads.map(point => point.date), ...wins.map(point => point.date)])].sort();
    const leadMap = new Map(leads.map(point => [point.date, validCount(point.count) ? point.count : null]));
    const wonMap = new Map(wins.map(point => [point.date, validCount(point.count) ? point.count : null]));
    const closedAvailable = metrics?.sources.closedDeals.status !== 'unavailable' && wins.some(point => validCount(point.count));
    const leadAvailable = leads.some(point => validCount(point.count));
    const rows = dates.map(date => ({ date, leads: leadMap.get(date) ?? null, won: closedAvailable ? wonMap.get(date) ?? null : null }));
    const scope = `${metrics?.business_id}:${metrics?.period.start}:${metrics?.period.days}`;
    useEffect(() => { setSelected(Math.max(0, dates.length - 1)); }, [scope, dates.length]);
    useLayoutEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const resize = () => { const next = node.getBoundingClientRect().width; if (next > 0) setWidth(Math.max(260, Math.round(next))); };
        resize();
        if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(resize); observer.observe(node); return () => observer.disconnect(); }
        window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
    }, [scope, dates.length]);
    const index = Math.min(selected, Math.max(0, rows.length - 1)), point = rows[index];
    const showLeads = visible.leads && leadAvailable, showWon = visible.won && closedAvailable;
    const peak = Math.max(1, ...rows.flatMap(row => [showLeads ? row.leads ?? 0 : 0, showWon ? row.won ?? 0 : 0]));
    const top = Math.max(1, Math.ceil(peak / 4) * 4);
    const x = (i: number) => 44 + (rows.length > 1 ? i / (rows.length - 1) : .5) * (width - 72);
    const y = (value: number) => 190 - value / top * 158;
    const path = (key: 'leads' | 'won') => {
        let next = true;
        return rows.map((row, i) => {
            const value = row[key];
            if (value === null) { next = true; return ''; }
            const segment = `${next ? 'M' : 'L'}${x(i)},${y(value)}`; next = false; return segment;
        }).join(' ');
    };
    const choose = (value: number) => setSelected(Math.max(0, Math.min(rows.length - 1, value)));
    const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (box.width) choose(Math.round(((event.clientX - box.left) / box.width * width - 44) / (width - 72) * (rows.length - 1)));
    };
    const toggle = (key: 'leads' | 'won') => setVisible(previous => {
        const other = key === 'leads' ? 'won' : 'leads';
        const otherAvailable = other === 'leads' ? leadAvailable : closedAvailable;
        if (previous[key] && (!previous[other] || !otherAvailable)) return previous;
        return { ...previous, [key]: !previous[key] };
    });
    if (!metrics) return <p className="cc-empty" role="status">{fallback}</p>;
    if (!dates.length || (!leadAvailable && !closedAvailable)) return <p className="cc-empty" role="status">Дневная история пока недоступна. Остальные показатели можно посмотреть выше.</p>;
    return <div className="cc-trend">
        <div className="cc-chart-legend" aria-label="Легенда графика">
            <button className="cc-series-toggle" type="button" aria-pressed={showLeads} disabled={!leadAvailable} onClick={() => toggle('leads')}><i className="cc-key-leads" aria-hidden="true" />Новые клиенты{!leadAvailable && ' · нет данных'}</button>
            <button className="cc-series-toggle" type="button" aria-pressed={showWon} disabled={!closedAvailable} onClick={() => toggle('won')}><i className="cc-key-won" aria-hidden="true" />Успешные сделки{!closedAvailable && ' · нет данных'}</button>
        </div>
        <svg ref={svgRef} className="cc-trend-svg" viewBox={`0 0 ${width} 224`} role="img" aria-labelledby={`${uid}-title ${uid}-description`} onPointerMove={trackPointer} onPointerDown={trackPointer}>
            <title id={`${uid}-title`}>Новые клиенты и успешные сделки за {metrics.period.days} дней</title>
            <desc id={`${uid}-description`}>Данные по дням. Выберите дату ползунком или откройте таблицу под графиком. Пропуски означают отсутствие данных.</desc>
            <defs><linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--cc-ai)" stopOpacity=".16" /><stop offset="100%" stopColor="var(--cc-ai)" stopOpacity="0" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line className="cc-chart-gridline" x1="44" x2={width - 28} y1={y(top / 4 * tick)} y2={y(top / 4 * tick)} /><text className="cc-axis-label" x="32" y={y(top / 4 * tick) + 4} textAnchor="end">{number.format(top / 4 * tick)}</text></g>)}
            {showLeads && rows.every(row => row.leads !== null) && <path d={`${path('leads')} L${x(rows.length - 1)},190 L${x(0)},190 Z`} fill={`url(#${uid}-fill)`} />}
            {showLeads && <path className="cc-line cc-line--leads" d={path('leads')} />}
            {showWon && <path className="cc-line cc-line--won" d={path('won')} />}
            <line className="cc-chart-cursor" x1={x(index)} x2={x(index)} y1="26" y2="190" />
            {showLeads && point?.leads !== null && <circle className="cc-point cc-point--leads" cx={x(index)} cy={y(point.leads)} r="4" />}
            {showWon && point?.won !== null && <rect className="cc-point cc-point--won" x={x(index) - 4} y={y(point.won) - 4} width="8" height="8" rx="1" />}
            {[...new Set([0, Math.floor((dates.length - 1) / 2), dates.length - 1])].map(i => <text className="cc-axis-label" key={i} x={x(i)} y="214" textAnchor={i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}>{dateLabel(dates[i])}</text>)}
        </svg>
        <div className="cc-chart-readout" aria-live="polite" aria-atomic="true"><strong>{dateLabel(point.date)}</strong><span>Новые клиенты: <b>{readable(point.leads)}</b></span><span>Успешные сделки: <b>{readable(point.won)}</b></span></div>
        <div className="cc-chart-navigation"><button className="cc-button" type="button" aria-label="Предыдущий день на графике" disabled={index === 0} onClick={() => choose(index - 1)}><ChevronLeft size={16} aria-hidden="true" /></button><label className="sr-only" htmlFor={`${uid}-day`}>Дата на графике</label><input id={`${uid}-day`} type="range" min="0" max={Math.max(0, rows.length - 1)} value={index} aria-valuetext={`${dateLabel(point.date)}. Новые клиенты: ${readable(point.leads)}. Успешные сделки: ${readable(point.won)}.`} onChange={event => choose(Number(event.target.value))} /><button className="cc-button" type="button" aria-label="Следующий день на графике" disabled={index === rows.length - 1} onClick={() => choose(index + 1)}><ChevronRight size={16} aria-hidden="true" /></button></div>
        {!rows.some(row => (row.leads ?? 0) > 0 || (row.won ?? 0) > 0) && <p className="cc-small cc-muted">{leadAvailable && closedAvailable && rows.every(row => row.leads !== null && row.won !== null) ? 'За этот период новых клиентов и учтённых успешных сделок нет.' : 'В доступной дневной истории новых событий пока нет.'}</p>}
        {metrics.sources.closedDeals.status === 'partial' && <p className="cc-small cc-muted">Успешные сделки показаны с момента начала учёта закрытий.</p>}
        <details className="cc-chart-data"><summary>Показать данные по дням</summary><div className="cc-chart-table-wrap" tabIndex={0} aria-label="Таблица динамики бизнеса"><table><caption className="sr-only">Новые клиенты и успешные сделки за {metrics.period.days} дней</caption><thead><tr><th scope="col">Дата</th><th scope="col">Новые клиенты</th><th scope="col">Успешные сделки</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><th scope="row">{dateLabel(row.date)}</th><td>{readable(row.leads)}</td><td>{readable(row.won)}</td></tr>)}</tbody></table></div></details>
    </div>;
}

export function MessageBalance({ metrics, fallback }: { metrics: DashboardMetrics | null; fallback: string }) {
    if (!metrics) return <p className="cc-empty" role="status">{fallback}</p>;
    const { inbound, outbound, total } = metrics.kpis.messages;
    if (![inbound, outbound, total].every(validCount) || inbound + outbound > total) return <p className="cc-empty" role="status">Данные о сообщениях пока недоступны.</p>;
    const entries = [{ label: 'Получено от клиентов', count: inbound, icon: <ArrowDownLeft size={16} aria-hidden="true" />, tone: 'inbound' },
        { label: 'Ответы клиентам', count: outbound, icon: <ArrowUpRight size={16} aria-hidden="true" />, tone: 'outbound' },
        ...(total > inbound + outbound ? [{ label: 'Другие сообщения', count: total - inbound - outbound, icon: null, tone: 'other' }] : [])];
    return <div className="cc-message-balance"><p className="cc-small cc-muted">За выбранный период · {number.format(total)} сообщений</p><dl>{entries.map(entry => <div key={entry.tone}><dt>{entry.icon}{entry.label}</dt><dd>{number.format(entry.count)}</dd><div className={`cc-message-track cc-message-track--${entry.tone}`} aria-hidden="true"><span style={{ width: `${total ? entry.count / total * 100 : 0}%` }} /></div></div>)}</dl>{total === 0 && <p className="cc-small cc-muted">Переписки за этот период пока нет.</p>}</div>;
}
