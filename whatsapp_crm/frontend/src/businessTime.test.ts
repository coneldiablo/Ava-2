import { describe, expect, it, vi } from 'vitest';
import { businessTimeZone, formatBusinessDate, utcDate } from './businessTime';
vi.mock('./context/InstanceContext', () => ({ useInstance: () => ({ currentInstance: { hotelTimezone: 'Europe/Moscow' } }) }));
describe('business timeline timestamps', () => {
    it('treats SQLite and ISO representations as the same UTC instant', () => {
        for (const value of ['2026-10-23 23:30:00', '2026-10-23T23:30:00', '2026-10-23T23:30:00Z', '2026-10-24T02:30:00+03:00']) {
            expect(utcDate(value)?.toISOString()).toBe('2026-10-23T23:30:00.000Z');
            expect(formatBusinessDate(value, true, 'Europe/Moscow')).toContain('24 октября 2026');
            expect(formatBusinessDate(value, true, 'Europe/Moscow')).toContain('02:30');
        }
    });
    it('uses the business zone on either side of midnight and DST', () => {
        expect(formatBusinessDate('2026-10-24 00:30:00', true, 'America/New_York')).toContain('23 октября 2026');
        expect(formatBusinessDate('2026-11-01 05:30:00', true, 'America/New_York')).toContain('01:30');
        expect(formatBusinessDate('2026-11-01T06:30:00Z', true, 'America/New_York')).toContain('01:30');
    });
    it('rejects unreadable values and falls back from invalid legacy zones', () => {
        expect(utcDate('not a date')).toBeNull();
        expect(formatBusinessDate(null, true)).toBe('Не указано');
        expect(businessTimeZone('broken/timezone')).toBe('Europe/Moscow');
    });
});
