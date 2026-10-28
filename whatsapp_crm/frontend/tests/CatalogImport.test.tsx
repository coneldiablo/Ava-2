// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CatalogImport from '../src/components/CatalogImport';
import { catalogImportRequest } from '../src/catalogImportApi';
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ userId: 'owner' }) }));
vi.mock('../src/catalogImportApi', () => ({ catalogImportRequest: vi.fn() }));
const preview = { id: '11111111-1111-4111-8111-111111111111', businessId: 7, status: 'preview', filename: 'products.csv', columns: [{ index: 0, name: 'Товар' }, { index: 1, name: 'Рубли' }], rowCount: 2, preview: [{ row: 2, cells: ['Пастух', '1000'] }, { row: 3, cells: ['Ошибка', 'не цена'] }], expiresAt: '2026-10-18T12:00:00Z' };
const validation = { validCount: 1, errorCount: 1, skippedCount: 0, errors: [{ row: 3, messages: ['Цена должна быть числом'] }], products: [{ row: 2, name: 'Пастух', amountMinor: 100000, currency: 'RUB', operation: 'add' }] };
const committed = { ...preview, status: 'committed', receipt: { status: 'partial', added: 1, updated: 0, skipped: [], errors: validation.errors, published: true } };
const changed = vi.fn();
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); vi.mocked(catalogImportRequest).mockResolvedValue({ import: preview }); });
afterEach(cleanup);
async function validated() {
    render(<CatalogImport businessId={7} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить таблицу' }));
    fireEvent.change(screen.getByLabelText('Таблица товаров'), { target: { files: [new File(['Товар,Рубли\nПастух,1000'], 'products.csv', { type: 'text/csv' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Открыть предпросмотр' }));
    fireEvent.change(await screen.findByLabelText('Название *'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Цена *'), { target: { value: '1' } });
    vi.mocked(catalogImportRequest).mockResolvedValueOnce({ validation });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить строки' }));
    await screen.findByText(/Корректных: 1/);
}
describe('canonical catalog import journey', () => {
    it('requires explicit partial import and publication then verifies the canonical receipt', async () => {
        await validated();
        expect((screen.getByRole('button', { name: 'Импортировать черновики' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByLabelText(/Загрузить только корректные/));
        fireEvent.click(screen.getByLabelText(/Опубликовать товары/));
        // Changed publication invalidates the plan and requires another review.
        expect(screen.queryByRole('button', { name: 'Импортировать и опубликовать' })).toBeNull();
        vi.mocked(catalogImportRequest).mockResolvedValueOnce({ validation });
        fireEvent.click(screen.getByRole('button', { name: 'Проверить строки' }));
        await screen.findByText(/Корректных: 1/);
        vi.mocked(catalogImportRequest).mockResolvedValueOnce({ import: committed }).mockResolvedValueOnce({ import: committed });
        fireEvent.click(screen.getByRole('button', { name: 'Импортировать и опубликовать' }));
        await screen.findByRole('heading', { name: 'Частичный импорт' });
        expect(catalogImportRequest).toHaveBeenCalledWith(7, `/${preview.id}/commit`, expect.objectContaining({ mapping: { name: 0, price: 1 }, publish: true, allowPartial: true, idempotencyKey: expect.any(String) }), expect.any(AbortSignal));
        expect(catalogImportRequest).toHaveBeenCalledWith(7, `/${preview.id}`, undefined, expect.any(AbortSignal));
        expect(changed).toHaveBeenCalledTimes(1);
    });
    it('preserves the commit key after an uncertain outcome and blocks a repeated click while pending', async () => {
        await validated(); fireEvent.click(screen.getByLabelText(/Загрузить только корректные/));
        vi.mocked(catalogImportRequest).mockRejectedValueOnce(new Error('connection lost'));
        fireEvent.click(screen.getByRole('button', { name: 'Импортировать черновики' })); await screen.findByRole('alert');
        const first = vi.mocked(catalogImportRequest).mock.calls.find(call => call[1].endsWith('/commit'))!;
        let resolve!: (value: unknown) => void;
        vi.mocked(catalogImportRequest).mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
        const button = screen.getByRole('button', { name: 'Импортировать черновики' }); fireEvent.click(button); fireEvent.click(button);
        await waitFor(() => expect(vi.mocked(catalogImportRequest).mock.calls.filter(call => call[1].endsWith('/commit'))).toHaveLength(2));
        const second = vi.mocked(catalogImportRequest).mock.calls.filter(call => call[1].endsWith('/commit'))[1];
        expect(second[2]).toEqual(first[2]);
        vi.mocked(catalogImportRequest).mockResolvedValueOnce({ import: committed }); resolve({ import: committed });
        await screen.findByRole('heading', { name: 'Частичный импорт' });
    });
    it('rejects unsupported or oversized files before calling the server', () => {
        render(<CatalogImport businessId={7} onChanged={changed} />); fireEvent.click(screen.getByRole('button', { name: 'Загрузить таблицу' }));
        fireEvent.change(screen.getByLabelText('Таблица товаров'), { target: { files: [new File(['x'], 'not-a-table.exe')] } });
        expect(screen.getByRole('alert').textContent).toContain('CSV или XLSX'); expect(catalogImportRequest).not.toHaveBeenCalled();
    });
});

it('restores a saved receipt through StrictMode cleanup without leaving an empty upload form', async () => {
    sessionStorage.setItem('ava:catalog-import:owner:7', preview.id);
    vi.mocked(catalogImportRequest).mockResolvedValue({ import: committed });
    render(<StrictMode><CatalogImport businessId={7} onChanged={changed} /></StrictMode>);
    expect(await screen.findByRole('heading', { name: 'Частичный импорт' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Открыть предпросмотр' })).toBeNull();
});
