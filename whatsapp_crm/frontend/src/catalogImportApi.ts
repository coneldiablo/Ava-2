import { api } from './api';
export type CatalogMapping = { name: number; price: number; sku?: number; currency?: number; description?: number; terms?: number };
export type CatalogImport = { id: string; businessId: number; status: 'preview' | 'committed' | 'rolled_back'; filename: string; columns: { index: number; name: string }[]; rowCount: number; preview: { row: number; cells: string[] }[]; expiresAt: string; receipt?: { status: 'completed' | 'partial'; added: number; updated: number; skipped: { row: number; reason: string }[]; errors: { row: number; messages: string[] }[]; published: boolean; rolledBackAt?: string } };
export type CatalogValidation = { validCount: number; errorCount: number; skippedCount: number; errors: { row: number; messages: string[] }[]; products: { row: number; name: string; amountMinor: number; currency: string; operation: 'add' | 'update' }[] };
export type CatalogImportInput = { mapping: CatalogMapping; mode: 'add' | 'upsert'; publish: boolean; allowPartial: boolean };
export async function catalogImportRequest<T>(businessId: number, action: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await api.request({ url: `/businesses/${businessId}/catalog-imports${action}`, method: body === undefined ? 'GET' : 'POST', data: body, signal, timeout: 30000 });
    if (response.data?.success !== true) throw new Error('CATALOG_IMPORT_FAILED');
    if (response.data.import && (response.data.import.businessId !== businessId || typeof response.data.import.id !== 'string' || !Array.isArray(response.data.import.columns))) throw new Error('CATALOG_IMPORT_SCOPE_INVALID');
    return response.data as T;
}
