export function customerPhone(phone?: string | null, chatId?: string | null): string | null {
    const source = phone?.trim() || (/^\+?\d{7,15}(?:@(c\.us|s\.whatsapp\.net))?$/.test(chatId || '') ? chatId!.split('@')[0] : '');
    if (!/^\+?[\d ()-]{7,24}$/.test(source)) return null;
    let digits = source.replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '8') digits = `7${digits.slice(1)}`;
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

export function formatCustomerPhone(phone?: string | null, chatId?: string | null): string | null {
    const canonical = customerPhone(phone, chatId);
    if (!canonical) return null;
    const digits = canonical.slice(1);
    return /^7\d{10}$/.test(digits) ? `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}` : canonical;
}

// This only changes presentation. A name, an opaque ID, or a phone suffix must
// never establish an identity link, assignment or permission.
export function customerDisplayName(name?: string | null, phone?: string | null, chatId?: string | null): string {
    const value = name?.trim() || '';
    const placeholder = /^(?:звонивший клиент|клиент(?: без имени)?|новый клиент|входящий звонок|абонент|caller|unknown|customer)$/iu.test(value);
    if (value && !placeholder && !customerPhone(value)) return value;
    return formatCustomerPhone(phone || (customerPhone(value) ? value : null), chatId) || (placeholder ? 'Клиент без имени' : value || 'Клиент без имени');
}
