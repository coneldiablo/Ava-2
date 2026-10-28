import { useInstance } from './context/InstanceContext';

// SQLite CURRENT_TIMESTAMP is UTC. Never let the browser infer a local zone.
export function utcDate(value?: string | number | null): Date | null {
    if (value == null || value === '') return null;
    const raw = typeof value === 'string' ? value.trim() : value;
    const normalized = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date : null;
}
export function businessTimeZone(value?: string | null): string {
    try { if (value) { new Intl.DateTimeFormat('ru-RU', { timeZone: value }).format(); return value; } } catch { /* Legacy invalid configuration uses the product default. */ }
    return 'Europe/Moscow';
}
export function formatBusinessDate(value?: string | number | null, includeTime = false, timeZone?: string | null): string {
    const date = utcDate(value);
    if (!date) return 'Не указано';
    return new Intl.DateTimeFormat('ru-RU', { timeZone: businessTimeZone(timeZone), day: 'numeric', month: 'long', year: 'numeric', ...(includeTime ? { hour: '2-digit', minute: '2-digit' } as const : {}) }).format(date);
}
export function useBusinessDate() {
    const { currentInstance } = useInstance();
    return (value?: string | number | null, includeTime = false) => formatBusinessDate(value, includeTime, currentInstance?.hotelTimezone);
}
