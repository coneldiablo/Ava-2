// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Studio from '../src/pages/Studio';

const scope = vi.hoisted(() => ({ businessId: 7, userId: 'owner', capabilities: ['sales.write', 'messages.send'] }));
vi.mock('../src/components/CommercialDocuments',()=>({default:()=>null}));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: scope.businessId }) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ userId: scope.userId, role: 'customer', memberships: [{ businessId: scope.businessId, role: 'hotel_owner', capabilities: scope.capabilities }] }) }));
const proposal = { success: true, businessId: 7, dealId: 'deal-7', revision: 1, draftText: 'Предложение по сделке', source: { dealTitle: 'Сделка', amountMinor: 10000, currency: 'RUB', clientName: null, hotelName: 'Бизнес' }, requiresManagerConfirmation: ['Доступность и сроки'] };
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fetchMock = vi.fn();
function CurrentLocation() { const location = useLocation(); return <output aria-label="Текущий адрес">{location.pathname}{location.search}</output>; }
const show = () => render(<MemoryRouter><Studio /><CurrentLocation /></MemoryRouter>);
async function selectDeal() {
    const select = await screen.findByLabelText('Сделка');
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'deal-7' } });
}
beforeEach(() => {
    vi.resetAllMocks(); sessionStorage.clear(); scope.businessId = 7; scope.userId = 'owner'; scope.capabilities = ['sales.write', 'messages.send']; vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: string) => url.includes('/studio/') ? response(proposal) : response({ success: true, business_id: scope.businessId, deals: [{ id: 'deal-7', title: 'Сделка', clientChatId: null, stage: 'new' }] }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Studio scoped recovery', () => {
    it('recovers a failed deal list locally without claiming that there are no deals', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Не удалось загрузить сделки.'));
        show(); await screen.findByRole('alert');
        expect(screen.queryByText(/Пока нет сделок/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку сделок' }));
        await selectDeal();
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить черновик' }));
        expect(await screen.findByDisplayValue(proposal.draftText)).toBeTruthy();
    });

    it('preserves edited material on cancellation and ignores a late replaced result', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        show(); await selectDeal();
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить черновик' }));
        const text = await screen.findByLabelText('Текст предложения') as HTMLTextAreaElement;
        fireEvent.change(text, { target: { value: 'Мои согласованные правки' } });
        let finish!: (value: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        fireEvent.click(screen.getByRole('button', { name: 'Обновить из сделки' }));
        const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
        fireEvent.click(screen.getByRole('button', { name: 'Отменить ожидание' }));
        expect(signal.aborted).toBe(true);
        expect(text.value).toBe('Мои согласованные правки');
        await act(async () => finish(response({ ...proposal, draftText: 'Поздний результат' })));
        expect(text.value).toBe('Мои согласованные правки');
        vi.restoreAllMocks();
    });

    it('aborts generation and clears previous material on a same-business user switch', async () => {
        let finish!: (value: Response) => void;
        const view = show(); await selectDeal();
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить черновик' }));
        const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
        scope.userId = 'next-owner'; view.rerender(<MemoryRouter><Studio /></MemoryRouter>);
        expect(signal.aborted).toBe(true);
        await act(async () => finish(response(proposal)));
        expect(screen.queryByDisplayValue(proposal.draftText)).toBeNull();
    });
});


const offer = { offerId: 'offer-1', offerRevision: 3, name: 'Пакет услуг', description: 'По опубликованным условиям', amountMinor: 120000, currency: 'RUB', terms: 'Оплата после согласования', publishedAt: '2026-10-15T08:00:00Z' };
type SavedMaterial = { revision: number; dealRevision: number; text: string; catalogItems: (typeof offer & { quantity: number; totalMinor: number })[]; createdAt: string; updatedBy: string };
function materialBackend() {
    let saved: SavedMaterial | null = null;
    const puts: { revision: number; dealRevision: number; text: string; catalogItems: { offerId: string; offerRevision: number; quantity: number }[]; idempotencyKey: string }[] = [];
    const process = async (url: string, options?: RequestInit): Promise<Response> => {
        if (url.endsWith('/material')) {
            const body = JSON.parse(String(options?.body)); puts.push(body);
            if (!saved) saved = { revision: 1, dealRevision: body.dealRevision, text: body.text, catalogItems: body.catalogItems.map((item: { quantity: number }) => ({ ...offer, quantity: item.quantity, totalMinor: offer.amountMinor * item.quantity })), createdAt: '2026-10-15T09:00:00Z', updatedBy: 'owner' };
            return response({ success: true, businessId: 7, dealId: 'deal-7', material: saved });
        }
        if (url.endsWith('/handoff')) return response({ success: true, businessId: 7, dealId: 'deal-7', material: saved, composer: { businessId: 7, chatId: 'client/1', text: saved?.text, materialRevision: saved?.revision, requiresHumanConfirmation: true, href: '/today?client=client%2F1&material=deal-7&materialRevision=1' } });
        if (url.includes('/studio/')) return response({ ...proposal, catalog: [offer], material: saved });
        return response({ success: true, business_id: 7, deals: [{ id: 'deal-7', title: 'Сделка', clientChatId: 'client/1', stage: 'new' }] });
    };
    return { process, puts, saved: () => saved };
}
async function prepareMaterial() { await selectDeal(); fireEvent.click(screen.getByRole('button', { name: 'Подготовить черновик' })); return await screen.findByLabelText('Текст предложения') as HTMLTextAreaElement; }

describe('Studio published catalogue and durable material', () => {
    it('saves editable text and published product references, confirms readback, then opens only the normal composer', async () => {
        const backend = materialBackend(); fetchMock.mockImplementation(backend.process);
        show(); const text = await prepareMaterial();
        fireEvent.click(screen.getByRole('checkbox', { name: /Пакет услуг/ }));
        fireEvent.change(screen.getByLabelText('Количество · Пакет услуг'), { target: { value: '2' } });
        fireEvent.change(text, { target: { value: 'Согласованный текст менеджера' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
        await screen.findByText('Материал сохранён и проверен. Отправка выполняется отдельно в диалоге после вашей проверки.');
        expect(backend.puts).toHaveLength(1);
        expect(backend.puts[0]).toEqual({ revision: 0, dealRevision: 1, text: 'Согласованный текст менеджера', catalogItems: [{ offerId: 'offer-1', offerRevision: 3, quantity: 2 }], idempotencyKey: expect.any(String) });
        expect(backend.saved()?.catalogItems[0].totalMinor).toBe(240000);
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и отправить в диалоге' }));
        await waitFor(() => expect(screen.getByLabelText('Текущий адрес').textContent).toBe('/today?client=client%2F1&material=deal-7&materialRevision=1'));
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reply'))).toBe(false);
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/handoff'))!;
        expect(JSON.parse(call[1].body)).toEqual({ revision: 1 });
    });

    it('reuses the exact idempotency key after a saved write whose readback temporarily fails', async () => {
        const backend = materialBackend(); let failRead = false;
        fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
            if (url.endsWith('/material')) { const result = await backend.process(url, options); if (backend.puts.length === 1) failRead = true; return result; }
            if (url.includes('/studio/') && failRead) { failRead = false; throw new Error('Temporary offline'); }
            return backend.process(url, options);
        });
        show(); const text = await prepareMaterial(); fireEvent.change(text, { target: { value: 'Сохраняемый текст' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' })); await screen.findByRole('alert');
        expect(text.value).toBe('Сохраняемый текст');
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
        await screen.findByText('Материал сохранён и проверен. Отправка выполняется отдельно в диалоге после вашей проверки.');
        expect(backend.puts).toHaveLength(2); expect(backend.puts[1]).toEqual(backend.puts[0]); expect(backend.saved()?.revision).toBe(1);
    });

    it('recovers an interrupted save and its key after reopening the same user and business', async () => {
        const backend = materialBackend(); let first = true; let interruptedBody: unknown;
        fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
            if (url.endsWith('/material') && first) { first = false; interruptedBody = JSON.parse(String(options?.body)); throw new Error('Offline before acknowledgment'); }
            return backend.process(url, options);
        });
        const view = show(); const text = await prepareMaterial(); fireEvent.change(text, { target: { value: 'Восстановленный текст' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' })); await screen.findByRole('alert'); view.unmount();
        show(); const restored = await prepareMaterial();
        expect(restored.value).toBe('Восстановленный текст');
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
        await screen.findByText('Материал сохранён и проверен. Отправка выполняется отдельно в диалоге после вашей проверки.');
        expect(backend.puts[0]).toEqual(interruptedBody);
    });

    it('preserves text on a catalogue version conflict and requires current published references', async () => {
        const backend = materialBackend();
        fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/material') ? ({ ok: false, status: 409, json: async () => ({ success: false, code: 'STUDIO_CATALOG_CHANGED' }) }) : backend.process(url, options));
        show(); const text = await prepareMaterial(); fireEvent.click(screen.getByRole('checkbox', { name: /Пакет услуг/ })); fireEvent.change(text, { target: { value: 'Мой текст при конфликте' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
        await screen.findByText('Цена или условия каталога изменились. Обновите данные и выберите актуальные позиции. Ваш текст сохранён.');
        expect(text.value).toBe('Мой текст при конфликте');
        expect((screen.getByRole('button', { name: 'Проверить и отправить в диалоге' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole('button', { name: 'Обновить данные, сохранив текст' })).toBeTruthy();
    });

    it('does not navigate to a composer belonging to another business', async () => {
        const backend = materialBackend();
        fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/handoff') ? response({ success: true, businessId: 8, dealId: 'deal-7', material: backend.saved(), composer: { businessId: 8, chatId: 'foreign', text: backend.saved()?.text, materialRevision: 1, requiresHumanConfirmation: true, href: '/today?client=foreign&material=deal-7&materialRevision=1' } }) : backend.process(url, options));
        show(); await prepareMaterial(); fireEvent.click(screen.getByRole('button', { name: 'Сохранить материал' }));
        await screen.findByText('Материал сохранён и проверен. Отправка выполняется отдельно в диалоге после вашей проверки.');
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и отправить в диалоге' }));
        await screen.findByText('Не удалось подтвердить получателя или сохранённый материал. Обновите данные.');
        expect(screen.getByLabelText('Текущий адрес').textContent).toBe('/');
    });

    it('keeps mutation controls unavailable without sales.write and messages.send', async () => {
        scope.capabilities = []; const backend = materialBackend(); fetchMock.mockImplementation(backend.process);
        show(); await prepareMaterial();
        expect(screen.queryByRole('button', { name: 'Сохранить материал' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Проверить и отправить в диалоге' })).toBeNull();
        expect(screen.getByRole('checkbox', { name: /Пакет услуг/ }).matches(':disabled')).toBe(true);
    });
});
