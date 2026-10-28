'use strict';

const DB = require('../database.service');
const Deals = require('../customer-deals.store');
const Audit = require('./deal-won-audit');

const DAYS = new Set([7, 30, 90]);
const STAGES = Deals.STAGES;

function fail(code, statusCode = 400) {
    throw Object.assign(new Error(code), { code, statusCode });
}

function businessId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) fail('DASHBOARD_SCOPE_INVALID');
    return id;
}

function parseDays(value) {
    const days = value === undefined ? 7 : Number(value);
    if (!DAYS.has(days) || String(days) !== String(value === undefined ? 7 : value)) {
        fail('DASHBOARD_DAYS_INVALID');
    }
    return days;
}

function ensureSchema() {
    if (!DB.db) fail('DASHBOARD_METRICS_UNAVAILABLE', 503);
    Deals.ensureSchema();
    Audit.ensureSchema();
}

function timezone(value) {
    const candidate = typeof value === 'string' && value.trim() ? value.trim() : 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
        return candidate;
    } catch (_) { return 'UTC'; }
}

function dateInZone(epoch, zone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(epoch);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addDate(date, offset) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

// Finds the first instant of a local day. It remains correct across DST shifts.
function midnightUtc(date, zone) {
    const approximate = Date.parse(`${date}T00:00:00Z`);
    let low = approximate - 48 * 3600000;
    let high = approximate + 48 * 3600000;
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (dateInZone(middle, zone) < date) low = middle;
        else high = middle;
    }
    return high;
}

function period(days, zone, now) {
    const asOf = new Date(now);
    if (!Number.isFinite(asOf.getTime())) fail('DASHBOARD_TIME_INVALID');
    const today = dateInZone(asOf.getTime(), zone);
    const first = addDate(today, 1 - days);
    const dates = Array.from({ length: days }, (_, index) => addDate(first, index));
    const start = new Date(midnightUtc(first, zone)).toISOString();
    const endExclusive = new Date(midnightUtc(addDate(today, 1), zone)).toISOString();
    return { days, timezone: zone, start, endExclusive, asOf: asOf.toISOString(), dates };
}

function storedEpoch(value) {
    if (typeof value !== 'string') return NaN;
    const raw = value.trim();
    const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
        ? `${raw.replace(' ', 'T')}Z` : raw;
    return Date.parse(utc);
}

function groupedAmounts(rows) {
    const totals = new Map();
    for (const row of rows) {
        const currency = String(row.currency || '').toUpperCase();
        const amountMinor = Number(row.amountMinor);
        if (!/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
            fail('DASHBOARD_AMOUNT_INVALID', 503);
        }
        const total = (totals.get(currency) || 0n) + BigInt(amountMinor);
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('DASHBOARD_AMOUNT_OVERFLOW', 503);
        totals.set(currency, total);
    }
    return [...totals].sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amountMinor]) => ({ currency, amountMinor: Number(amountMinor) }));
}

// The historical funnel below intentionally keeps its created-in-period scope.
// Current work is a separate snapshot: an older open deal must not disappear
// when the owner changes the chart's period.
function currentFunnel(instanceId) {
    try {
        const stages = STAGES.filter(stage => !['won', 'lost'].includes(stage));
        const rows = DB.all(`SELECT stage,currency,amountMinor FROM customer_deals
            WHERE instanceId=? AND stage IN ('new','qualified','proposal','negotiation')`, [instanceId]);
        return { status: 'available', scope: 'all_open', totalOpen: rows.length,
            items: stages.map(stage => {
                const items = rows.filter(row => row.stage === stage);
                return { stage, count: items.length, amounts: groupedAmounts(items) };
            }) };
    } catch (_) {
        // A failed snapshot is not an empty funnel. Existing period metrics
        // remain usable without manufacturing zero counts for current work.
        return { status: 'unavailable', scope: 'all_open', totalOpen: null, items: [] };
    }
}

function getMetrics(instanceId, days = 7, now = new Date()) {
    const id = businessId(instanceId);
    const validDays = parseDays(days);
    ensureSchema();
    const business = DB.get('SELECT id,hotelTimezone FROM instances WHERE id=? AND isActive=1', [id]);
    if (!business) fail('DASHBOARD_BUSINESS_NOT_FOUND', 404);
    const window = period(validDays, timezone(business.hotelTimezone), now);
    const { start, endExclusive, asOf } = window;
    Audit.markTenant(id);
    const coverage = DB.get('SELECT trackingStartedAt FROM dashboard_metrics_coverage WHERE instanceId=?', [id]);

    const leadTotals = DB.get(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN leadStatus NOT IN ('booked','junk','pickup_confirmed','ready_for_pickup') THEN 1 ELSE 0 END),0) AS active
        FROM clients WHERE instanceId=?`, [id]);
    const leads = DB.all(`SELECT createdAt FROM clients WHERE instanceId=?
        AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)
        AND julianday(createdAt)<=julianday(?)`, [id, start, endExclusive, asOf]);
    const messages = DB.get(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN role='user' THEN 1 ELSE 0 END),0) AS inbound,
        COALESCE(SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END),0) AS outbound
        FROM messages WHERE instanceId=? AND julianday(timestamp)>=julianday(?)
        AND julianday(timestamp)<julianday(?) AND julianday(timestamp)<=julianday(?)`, [id, start, endExclusive, asOf]);
    const deals = DB.all(`SELECT stage,currency,amountMinor FROM customer_deals WHERE instanceId=?
        AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)
        AND julianday(createdAt)<=julianday(?)`, [id, start, endExclusive, asOf]);
    // A reopened and re-won deal is one current win, dated at its latest close.
    // Joining the current stage also removes reversed wins from revenue.
    const wonEvents = DB.all(`SELECT e.occurredAt,e.currency,e.amountMinor FROM dashboard_deal_won_events e
        JOIN customer_deals d ON d.instanceId=e.instanceId AND d.id=e.dealId AND d.stage='won'
        WHERE e.instanceId=? AND e.id=(SELECT MAX(previous.id) FROM dashboard_deal_won_events previous
            WHERE previous.instanceId=? AND previous.dealId=e.dealId)
        AND julianday(e.occurredAt)>=julianday(?) AND julianday(e.occurredAt)<julianday(?)
        AND julianday(e.occurredAt)<=julianday(?)`, [id, id, start, endExclusive, asOf]);
    const toolRuns = DB.get(`SELECT COUNT(*) AS count FROM tool_runs WHERE instanceId=? AND status='ok'
        AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)
        AND julianday(createdAt)<=julianday(?)`, [id, start, endExclusive, asOf]);

    const leadSeries = new Map(window.dates.map(date => [date, { date, count: 0 }]));
    for (const lead of leads) {
        const epoch = storedEpoch(lead.createdAt);
        if (!Number.isFinite(epoch) || epoch > Date.parse(asOf)) continue;
        const bin = leadSeries.get(dateInZone(epoch, window.timezone));
        if (bin) bin.count += 1;
    }
    const closedSeries = new Map(window.dates.map(date => [date, { date, count: 0, amounts: [] }]));
    const amountsByDay = new Map(window.dates.map(date => [date, []]));
    for (const event of wonEvents) {
        const epoch = storedEpoch(event.occurredAt);
        if (!Number.isFinite(epoch) || epoch > Date.parse(asOf)) continue;
        const day = dateInZone(epoch, window.timezone);
        const bin = closedSeries.get(day);
        if (bin) {
            bin.count += 1;
            amountsByDay.get(day).push(event);
        }
    }
    for (const [date, bin] of closedSeries) bin.amounts = groupedAmounts(amountsByDay.get(date));

    const dealFunnel = STAGES.map(stage => {
        const rows = deals.filter(deal => deal.stage === stage);
        return { stage, count: rows.length, amounts: groupedAmounts(rows) };
    });
    const openDeals = deals.filter(deal => !['won', 'lost'].includes(deal.stage));
    const closed = wonEvents.filter(event => {
        const epoch = storedEpoch(event.occurredAt);
        return Number.isFinite(epoch) && epoch <= Date.parse(asOf);
    });
    const { dates, ...periodInfo } = window;
    return {
        success: true, business_id: id, period: periodInfo,
        kpis: {
            leads: { created: [...leadSeries.values()].reduce((n, day) => n + day.count, 0),
                total: leadTotals.total, active: leadTotals.active },
            messages: { inbound: messages.inbound, outbound: messages.outbound, total: messages.total },
            deals: { created: deals.length, open: openDeals.length, won: closed.length,
                lost: deals.filter(deal => deal.stage === 'lost').length,
                openAmounts: groupedAmounts(openDeals), wonAmounts: groupedAmounts(closed) },
            ai: { recordedSuccessfulToolRuns: toolRuns.count, status: 'partial' },
        },
        series: { leads: [...leadSeries.values()], closedDeals: [...closedSeries.values()] },
        dealFunnel,
        currentFunnel: currentFunnel(id),
        sources: {
            closedDeals: { status: 'partial', trackingStartedAt: new Date(storedEpoch(coverage.trackingStartedAt)).toISOString(),
                description: 'Latest recorded close of deals currently won; older wins lack an exact close date.' },
            ai: { status: 'partial', description: 'Successful tool_runs only; not a complete AI action ledger.' },
        },
    };
}

module.exports = { getMetrics, ensureSchema, parseDays, period, storedEpoch };
