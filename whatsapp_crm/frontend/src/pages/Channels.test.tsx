// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { connectWhatsApp, disconnectChannel, getChannelStatus, getOpenWaStatus, logoutOpenWa, replaceWhatsApp, saveChannelConfig } from '../api';
import Channels from './Channels';

const shared = vi.hoisted(() => ({ sessionId: undefined as string | undefined, gatewayState: 'notAuthorized', instagramMounts: 0, permissionsLoading: false }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ userId: 'owner-7', role: 'customer', permissionsLoading: shared.permissionsLoading, memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'business.manage'] }] }) }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 7, currentInstance: { id: 7, name: 'Test', openWaSessionId: shared.sessionId }, refreshInstances: vi.fn() }) }));
vi.mock('../components/InstagramConnectionPanel', () => ({ default: () => { shared.instagramMounts += 1; return <section aria-label="Подключение Instagram">Instagram panel</section>; } }));
vi.mock('../api/telephony', () => ({ getManualPhones:vi.fn(async()=>({inboundNumbers:[],outboundNumber:null})),getTelephony:vi.fn(async()=>({success:true,canManage:false,canPurchase:false,pilotEnabled:false,numbers:[],orders:[],limits:{numbers:3},remainingSeconds:1800,notices:[]})) }));
vi.mock('../api', () => ({
    getChannelStatus: vi.fn(async () => ({ success: true, channels: { whatsapp: false, telegram: false, email: false, vk: false, max: false } })),
    getOpenWaStatus: vi.fn(async () => ({ success: true, state: { stateInstance: shared.gatewayState } })),
    getOpenWaQR: vi.fn(async () => ({ success: true, type: 'qrCode', message: 'QUJD' })),
    connectWhatsApp: vi.fn(async () => ({ success: true, type: 'qrCode', message: 'QUJD' })),
    replaceWhatsApp: vi.fn(async () => ({ success: true, type: 'qrCode', message: 'QUJD' })),
    logoutOpenWa: vi.fn(async () => { shared.gatewayState = 'disconnected'; return { success: true }; }),
    saveChannelConfig: vi.fn(async (_id: number, payload: Record<string, string>) => ({ success: true, savedFields: Object.keys(payload) })), disconnectChannel: vi.fn(async () => ({ success: true })),
    testTelegram: vi.fn(), testEmail: vi.fn(), testVk: vi.fn(), testMax: vi.fn(),
    getPmsIntegration: vi.fn(async () => ({ success: true, businessId: 7, pms: null })),
    configurePmsIntegration: vi.fn(async (_id: number, data: any) => ({ success: true, businessId: 7, pms: { business_id: 7, provider: 'bnovo', enabled: true, credentials_configured: true, connection_status: 'not_tested', currency: 'RUB', ...data } })),
    disconnectPmsIntegration: vi.fn(async () => ({ success: true, businessId: 7, deleted: true })),
    testPmsIntegration: vi.fn(async () => ({ success: true, businessId: 7, pms: { business_id: 7, provider: 'bnovo', connection_status: 'connected', external_hotel_id: '1234' } })),
    syncPmsIntegration: vi.fn(async () => ({ success: true, businessId: 7, queued: 12 })),
    connectPmsWebhooks: vi.fn(async () => ({ success: true, businessId: 7, pms: { webhook_status: 'healthy' } })),
    getPmsBookings: vi.fn(async () => ({ success: true, businessId: 7, bookings: [] })),
    getPmsBookingRequests: vi.fn(async () => ({ success: true, businessId: 7, booking_requests: [] })),
}));
const show = (path = '/channels') => render(<MemoryRouter initialEntries={[path]}><Channels /></MemoryRouter>);
const openCard = async (name: string) => {
    const grid = await screen.findByLabelText('Подключаемые каналы');
    fireEvent.click(within(grid).getByRole('button', { name: new RegExp(name) }));
};

describe('Channels', () => {
    it('opens telephony when the unrelated channel status endpoint fails', async () => {
        vi.mocked(getChannelStatus).mockRejectedValueOnce(new Error('unavailable'));
        show();
        await openCard('Телефония');
        await screen.findByRole('region', { name:'Телефония' });
        expect(screen.getByRole('button', { name:/Телефония Открыть номера/ }).textContent).not.toContain('Не подключён');
    });
    it('opens telephony directly while other channel status is pending', async () => {
        vi.mocked(getChannelStatus).mockImplementationOnce(()=>new Promise(()=>{}));
        show('/channels?channel=telephony');
        await screen.findByRole('region', { name:'Телефония' });
        expect(screen.getByRole('button', { name:/Телефония Открыть номера/ }).getAttribute('aria-pressed')).toBe('true');
    });
    beforeEach(() => { vi.clearAllMocks(); shared.sessionId = undefined; shared.gatewayState = 'notAuthorized'; shared.instagramMounts = 0; shared.permissionsLoading = false; });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
    it('shows a list first and mounts Instagram only after its card is selected', async () => {
        show();
        await screen.findByLabelText('Подключаемые каналы');
        expect(shared.instagramMounts).toBe(0);
        expect(screen.queryByLabelText('Подключение Instagram')).toBeNull();
        await openCard('Instagram');
        expect(screen.getByLabelText('Подключение Instagram')).toBeTruthy();
        await openCard('Telegram');
        expect(screen.queryByLabelText('Подключение Instagram')).toBeNull();
        expect(screen.getByText('Токен Telegram-бота')).toBeTruthy();
    });
    it('opens the WhatsApp setup directly from a channel link', async () => {
        show('/channels?channel=whatsapp');
        await screen.findByText('Ожидает привязки');
        const grid = screen.getByLabelText('Подключаемые каналы');
        expect(within(grid).getByRole('button', { name: /^WhatsApp / }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByLabelText('Подключение Instagram')).toBeNull();
    });
    it('opens Instagram only when its channel link requests it', async () => {
        show('/channels?channel=instagram');
        await screen.findByLabelText('Подключение Instagram');
        const grid = screen.getByLabelText('Подключаемые каналы');
        expect(within(grid).getByRole('button', { name: /^Instagram / }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByText('Ожидает привязки')).toBeNull();
    });
    it('keeps Instagram pending until the private Direct inbound is confirmed', async () => {
        vi.mocked(getChannelStatus).mockResolvedValueOnce({ success: true, channels: {
            whatsapp: false, telegram: false, email: false, vk: false, max: false,
            instagram: true, instagramConfigured: true, instagramState: 'connected', instagramInboundConfirmed: false,
        } });
        show();
        const card = within(await screen.findByLabelText('Подключаемые каналы')).getByRole('button', { name: /^Instagram / });
        expect(card.textContent).toContain('Ждём Direct');
        expect(card.textContent).not.toContain('Подключён');
        expect(card.querySelector('.is-connected')).toBeNull();
    });
    it('shows Instagram connected only for a confirmed private Direct inbound', async () => {
        vi.mocked(getChannelStatus).mockResolvedValueOnce({ success: true, channels: {
            whatsapp: false, telegram: false, email: false, vk: false, max: false,
            instagram: true, instagramConfigured: true, instagramState: 'connected', instagramInboundConfirmed: true,
        } });
        show();
        const card = within(await screen.findByLabelText('Подключаемые каналы')).getByRole('button', { name: /^Instagram / });
        expect(card.textContent).toContain('Подключён');
        expect(card.textContent).toContain('Новый Direct сохранён в AVA');
        expect(card.querySelector('.is-connected')).not.toBeNull();
    });
    it('opens WhatsApp here and shows QR after connecting', async () => {
        show(); await openCard('WhatsApp');
        await screen.findByText('Ожидает привязки');
        fireEvent.click(screen.getByRole('button', { name: 'Подключить WhatsApp' }));
        await screen.findByAltText('QR для подключения WhatsApp к Test');
        expect(connectWhatsApp).toHaveBeenCalledWith(7);
        expect(replaceWhatsApp).not.toHaveBeenCalled();
    });
    it('retries a failed session without replacing its account or logging it out', async () => {
        shared.sessionId = 'failed-session'; shared.gatewayState = 'failed';
        vi.mocked(connectWhatsApp).mockImplementationOnce(async () => { shared.gatewayState = 'notAuthorized'; return { success: true, type: 'qrCode', message: 'QUJD' }; });
        show(); await openCard('WhatsApp');
        const button = await screen.findByRole('button', { name: 'Повторить подключение' });
        expect(screen.queryByText('Заблокирован')).toBeNull();
        fireEvent.click(button);
        await screen.findByAltText('QR для подключения WhatsApp к Test');
        await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
        expect(connectWhatsApp).toHaveBeenCalledWith(7);
        expect(replaceWhatsApp).not.toHaveBeenCalled();
        expect(logoutOpenWa).not.toHaveBeenCalled();
    });
    it('reopens an existing QR after navigation without forcing a number replacement', async () => {
        shared.sessionId = 'pending-session'; shared.gatewayState = 'notAuthorized';
        show(); await openCard('WhatsApp');
        fireEvent.click(await screen.findByRole('button', { name: 'Показать QR' }));
        await screen.findByAltText('QR для подключения WhatsApp к Test');
        expect(connectWhatsApp).toHaveBeenCalledWith(7);
        expect(replaceWhatsApp).not.toHaveBeenCalled();
    });
    it('unlocks actions after a failed connection request and status refresh', async () => {
        shared.sessionId = 'failed-session'; shared.gatewayState = 'failed';
        vi.mocked(connectWhatsApp).mockRejectedValueOnce(new Error('timeout'));
        show(); await openCard('WhatsApp');
        fireEvent.click(await screen.findByRole('button', { name: 'Повторить подключение' }));
        await screen.findByText('Не удалось подтвердить действие WhatsApp. Обновите статус и повторите попытку.');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Повторить подключение' }).hasAttribute('disabled')).toBe(false));
        expect(within(screen.getByRole('region', { name: 'WhatsApp' })).getByRole('button', { name: 'Обновить статус' }).hasAttribute('disabled')).toBe(false);
    });
    it('requires confirmed logout before replacing the old WhatsApp number', async () => {
        shared.sessionId = 'old-session'; shared.gatewayState = 'authorized';
        vi.stubGlobal('confirm', vi.fn(() => true));
        show(); await openCard('WhatsApp');
        await screen.findByRole('button', { name: 'Отключить старый номер' });
        expect(screen.queryByRole('button', { name: 'Подключить новый номер' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Отключить старый номер' }));
        await screen.findByText(/Старый номер отключён и проверен/);
        expect(logoutOpenWa).toHaveBeenCalledWith(7);
        fireEvent.click(screen.getByRole('button', { name: 'Подключить новый номер' }));
        await waitFor(() => expect(replaceWhatsApp).toHaveBeenCalledWith(7, 'old-session'));
        expect(getOpenWaStatus).toHaveBeenCalledWith(7, true);
    });
    it('blocks replacement when the gateway has not confirmed logout', async () => {
        shared.sessionId = 'old-session'; shared.gatewayState = 'authorized';
        vi.mocked(logoutOpenWa).mockResolvedValueOnce({ success: true });
        vi.stubGlobal('confirm', vi.fn(() => true));
        show(); await openCard('WhatsApp');
        const button = await screen.findByRole('button', { name: 'Отключить старый номер' });
        fireEvent.click(button);
        await screen.findByText(/Не удалось подтвердить отключение/);
        expect(screen.queryByRole('button', { name: 'Подключить новый номер' })).toBeNull();
        expect(replaceWhatsApp).not.toHaveBeenCalled();
    });
    it('retains setup forms for Telegram, VK, MAX and email', async () => {
        show();
        for (const [channel, field] of [['Telegram', 'Токен Telegram-бота'], ['ВКонтакте', 'ID сообщества'], ['MAX', 'Токен MAX-бота'], ['Почта', 'SMTP-сервер']]) {
            await openCard(channel);
            expect(screen.getByText(field)).toBeTruthy();
        }
    });
    it.each([['telegram', 'Токен Telegram-бота'], ['email', 'SMTP-сервер'], ['vk', 'ID сообщества'], ['max', 'Токен MAX-бота']])('opens the selected %s form from its existing route', async (channel, field) => {
        show(`/channels?channel=${channel}`);
        expect(await screen.findByLabelText(field)).toBeTruthy();
        expect(screen.queryByLabelText('Подключение Instagram')).toBeNull();
    });
    it('keeps channels available with an honest unknown status when the status request fails', async () => {
        vi.mocked(getChannelStatus).mockRejectedValueOnce(new Error('offline'));
        show();
        await screen.findByText(/Состояние каналов недоступно/);
        const telegram = within(screen.getByLabelText('Подключаемые каналы')).getByRole('button', { name: /^Telegram / });
        expect(telegram.textContent).toContain('Статус не получен');
        expect(telegram.textContent).not.toContain('Не подключён');
        fireEvent.click(telegram);
        expect(screen.getByLabelText('Токен Telegram-бота')).toBeTruthy();
    });
    it('retains each channel draft and submits only the selected channel fields', async () => {
        show(); await openCard('Telegram');
        fireEvent.change(screen.getByLabelText('Токен Telegram-бота'), { target: { value: 'private-test-token' } });
        await openCard('Почта');
        fireEvent.change(screen.getByLabelText('SMTP-сервер'), { target: { value: 'smtp.test.example' } });
        await openCard('Telegram');
        expect((screen.getByLabelText('Токен Telegram-бота') as HTMLInputElement).value).toBe('private-test-token');
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
        await screen.findByText(/Настройки приняты для выбранного бизнеса/);
        expect(saveChannelConfig).toHaveBeenCalledWith(7, { telegramBotToken: 'private-test-token' });
        await openCard('Почта');
        expect((screen.getByLabelText('SMTP-сервер') as HTMLInputElement).value).toBe('smtp.test.example');
    });
    it('keeps credentials and avoids a save confirmation when status readback fails', async () => {
        show(); await openCard('Telegram');
        fireEvent.change(screen.getByLabelText('Токен Telegram-бота'), { target: { value: 'private-test-token' } });
        vi.mocked(getChannelStatus).mockRejectedValueOnce(new Error('offline'));
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
        await screen.findByText(/Настройки приняты, но состояние канала проверить не удалось/);
        expect((screen.getByLabelText('Токен Telegram-бота') as HTMLInputElement).value).toBe('private-test-token');
        expect(screen.queryByText(/Настройки приняты для выбранного бизнеса/)).toBeNull();
    });
    it('does not confirm a disconnect while the configured channel remains on readback', async () => {
        vi.mocked(getChannelStatus).mockResolvedValue({ success: true, channels: { whatsapp: false, telegram: false, telegramConfigured: true, email: false, vk: false, max: false } });
        vi.stubGlobal('confirm', vi.fn(() => true));
        show('/channels?channel=telegram');
        fireEvent.click(await screen.findByRole('button', { name: 'Отключить канал' }));
        await screen.findByText(/Не удалось подтвердить отключение/);
        expect(disconnectChannel).toHaveBeenCalledWith(7, 'telegram');
        expect(screen.queryByText('Канал отключён. История диалогов сохранена.')).toBeNull();
    });
    it('displays Bnovo in the channel grid and opens Bnovo panel on click', async () => {
        show();
        const grid = await screen.findByLabelText('Подключаемые каналы');
        const bnovoCard = within(grid).getByRole('button', { name: /^Bnovo / });
        expect(bnovoCard).toBeTruthy();
        expect(bnovoCard.textContent).toContain('Бронирования');

        fireEvent.click(bnovoCard);
        expect(await screen.findByRole('heading', { name: 'Bnovo' })).toBeTruthy();
        expect(screen.getByText('ID аккаунта Bnovo')).toBeTruthy();
    });
    it('opens Bnovo directly from a channel query param', async () => {
        show('/channels?channel=bnovo');
        expect(await screen.findByRole('heading', { name: 'Bnovo' })).toBeTruthy();
        const grid = screen.getByLabelText('Подключаемые каналы');
        expect(within(grid).getByRole('button', { name: /^Bnovo / }).getAttribute('aria-pressed')).toBe('true');
    });
    it('shows Bnovo connected status when reported in channel status', async () => {
        vi.mocked(getChannelStatus).mockResolvedValueOnce({
            success: true,
            channels: {
                whatsapp: false, telegram: false, email: false, vk: false, max: false,
                bnovo: true, bnovoConfigured: true, bnovoExternalHotelId: '990', bnovoMaskedAccount: '••••1234',
            },
        });
        show();
        const grid = await screen.findByLabelText('Подключаемые каналы');
        const bnovoCard = within(grid).getByRole('button', { name: /^Bnovo / });
        expect(bnovoCard.textContent).toContain('Подключён');
        expect(bnovoCard.textContent).toContain('Отель #990');
    });
});
