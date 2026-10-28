import { describe, expect, it } from 'vitest';
import { customerDisplayName, customerPhone, formatCustomerPhone } from './customerDisplay';

describe('customer presentation without identity inference', () => {
    it('replaces caller placeholders with the complete Russian phone and keeps real names', () => {
        expect(customerDisplayName('Звонивший клиент', null, '79990000001@c.us')).toBe('+7 (999) 000-00-01');
        expect(customerDisplayName('Анна', null, '79990000001@c.us')).toBe('Анна');
        expect(customerDisplayName('79990000001')).toBe('+7 (999) 000-00-01');
        expect(formatCustomerPhone('8 (999) 000-00-01')).toBe('+7 (999) 000-00-01');
    });
    it('never treats opaque messenger identifiers or usernames as a phone', () => {
        for (const id of ['tg_79990000001', 'max_79990000001', 'avito:123:79990000001', '79990000001@lid', '@username']) {
            expect(customerPhone(null, id)).toBeNull();
            expect(customerDisplayName('Звонивший клиент', null, id)).toBe('Клиент без имени');
        }
        expect(customerPhone('+12025550123')).toBe('+12025550123');
    });
});
