/** Labels for channels already handled by the shared conversation router. */
export const messageChannelLabels: Record<string, string> = {
    whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'Почта',
    vk: 'ВКонтакте', max: 'MAX', instagram: 'Instagram', avito: 'Авито',
};
export function channelLabel(channel: string | null | undefined): string {
    if (!channel) return 'Канал не указан';
    const normalized = channel.toLowerCase();
    return messageChannelLabels[normalized]
        || ({ voice: 'Звонок', sip: 'Звонок', phone: 'Телефон', web: 'Веб' } as Record<string, string>)[normalized]
        || 'Другой канал';
}
