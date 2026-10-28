export type BusinessType = 'hotel' | 'standard' | 'coffee_shop';

export interface BusinessInstance {
    businessType?: BusinessType;
    salesGoal?: string;
}

export interface PipelineStatus {
    id: string;
    label: string;
    title: string;
    color: string;
    emoji: string;
}

export const STANDARD_PIPELINE: PipelineStatus[] = [
    { id: 'new', label: 'Новый', title: 'Новые', color: '#3b82f6', emoji: '🆕' },
    { id: 'qualified', label: 'Квалификация', title: 'Квалификация', color: '#8b5cf6', emoji: '✅' },
    { id: 'audit', label: 'Аудит / Созвон', title: 'Аудит / Созвон', color: '#f59e0b', emoji: '📞' },
    { id: 'offer', label: 'КП отправлено', title: 'Отправлено КП', color: '#f97316', emoji: '💰' },
    { id: 'booked', label: 'Успешно', title: 'Успешно', color: '#22c55e', emoji: '🎉' },
    { id: 'junk', label: 'Отказ / Спам', title: 'Отказ / Спам', color: '#ef4444', emoji: '🚫' },
];

export const COFFEE_PIPELINE: PipelineStatus[] = [
    { id: 'new', label: 'Новое обращение', title: 'Новые обращения', color: '#3b82f6', emoji: '🆕' },
    { id: 'qualified', label: 'Выбор заказа', title: 'Выбирают заказ', color: '#8b5cf6', emoji: '☕' },
    { id: 'audit', label: 'Уточнение заказа', title: 'Уточнение заказа', color: '#f59e0b', emoji: '🧾' },
    { id: 'offer', label: 'Передано бариста', title: 'Передано бариста', color: '#f97316', emoji: '👨‍🍳' },
    { id: 'pickup_confirmed', label: 'Самовывоз подтверждён', title: 'Самовывоз подтверждён', color: '#14b8a6', emoji: '✅' },
    { id: 'ready_for_pickup', label: 'Готов к выдаче', title: 'Готовы к выдаче', color: '#22c55e', emoji: '🏁' },
    { id: 'junk', label: 'Отказ / Спам', title: 'Отказ / Спам', color: '#ef4444', emoji: '🚫' },
];

export function getBusinessType(instance?: BusinessInstance | null): BusinessType {
    if (instance?.businessType === 'coffee_shop' || instance?.salesGoal === 'coffee_pickup') {
        return 'coffee_shop';
    }
    if (instance?.businessType === 'hotel') {
        return 'hotel';
    }
    return 'standard';
}

export function isCoffeeBusiness(instance?: BusinessInstance | null): boolean {
    return getBusinessType(instance) === 'coffee_shop';
}

export function getPipeline(instance?: BusinessInstance | null): PipelineStatus[] {
    return isCoffeeBusiness(instance) ? COFFEE_PIPELINE : STANDARD_PIPELINE;
}

export function getBusinessTypeLabel(instance?: BusinessInstance | null): string {
    const type = getBusinessType(instance);
    if (type === 'coffee_shop') return 'Кофейня';
    if (type === 'hotel') return 'Отель';
    return 'Обычный бизнес';
}
