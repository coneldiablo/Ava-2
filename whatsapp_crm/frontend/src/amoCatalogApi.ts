import { api } from './api';
export type AmoCatalogMapping = { catalogId?: number; priceFieldId?: number; unitFieldId?: number; currency?: string };
export type AmoSource = { accountId: string; catalogId: string; elementId: string; unit?: string | null; sku?: string | null; offerId?: string; checkedAt?: string; publishedAt?: string; stale?: boolean; localConflict?: boolean };
export type AmoPreview = { previewId: string; accountId: string; catalogId: number; catalogName: string; mapping: AmoCatalogMapping; checkedAt: string; sourceRevision: string; complete: boolean; errors: { elementId: string; code: string }[]; items: { elementId: string; offerId: string; source: AmoSource; manuallyChanged: boolean; retired: boolean; errors: string[]; offer: { name: string; description: string; terms: string; amountMinor: number | null; currency: string | null } | null }[] };
export type AmoPublication = { previewId: string; publishedAt: string; replayed?: boolean; results: { elementId: string; offerId?: string; status: 'published' | 'retired' | 'unchanged' | 'skipped' | 'conflict' }[] };
export type AmoCatalog = { settings: { enabled: boolean; intervalMinutes: number; mapping?: AmoCatalogMapping; nextAt?: number; lastError?: string | null }; preview: AmoPreview | null; publication: AmoPublication | null; sources: AmoSource[] };
const path = (id: number) => `/external-integrations/${id}/amocrm/catalog`;
export async function getAmoCatalog(id: number, signal?: AbortSignal): Promise<AmoCatalog> {
 const { data } = await api.get(path(id), { signal, timeout: 20000 });
 if (!data.success || !data.catalog || !Array.isArray(data.catalog.sources)) throw new Error('Не удалось проверить каталог amoCRM.'); return data.catalog;
}
export async function previewAmoCatalog(id: number, input: AmoCatalogMapping, signal?: AbortSignal): Promise<AmoPreview> {
 const { data } = await api.post(path(id) + '/preview', input, { signal, timeout: 45000 });
 if (!data.success || !data.preview?.previewId || data.preview.complete !== true) throw new Error('Предпросмотр не подтверждён. Проверьте сохранённое состояние.'); return data.preview;
}
export async function publishAmoCatalog(id: number, previewId: string, signal?: AbortSignal): Promise<AmoPublication> {
 const { data } = await api.post(path(id) + '/publish', { previewId }, { signal, timeout: 30000 });
 if (!data.success || data.publication?.previewId !== previewId) throw new Error('Публикация не подтверждена. Проверьте сохранённое состояние.'); return data.publication;
}
export async function saveAmoCatalogSchedule(id: number, input: { enabled: boolean; intervalMinutes: number }, signal?: AbortSignal): Promise<AmoCatalog> {
 const { data } = await api.put(path(id) + '/settings', input, { signal, timeout: 20000 });
 if (!data.success || !data.catalog) throw new Error('Настройки не подтверждены. Проверьте сохранённое состояние.'); return data.catalog;
}
