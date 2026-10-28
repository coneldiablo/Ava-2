// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BnovoIntegrationPanel from './BnovoIntegrationPanel';
import {
    configurePmsIntegration,
    connectPmsWebhooks,
    disconnectPmsIntegration,
    getPmsBookings,
    getPmsIntegration,
    syncPmsIntegration,
    testPmsIntegration,
    type PmsIntegration,
    type PmsBooking,
} from '../api';

vi.mock('../api', () => ({
    getPmsIntegration: vi.fn(),
    configurePmsIntegration: vi.fn(),
    disconnectPmsIntegration: vi.fn(),
    testPmsIntegration: vi.fn(),
    syncPmsIntegration: vi.fn(),
    connectPmsWebhooks: vi.fn(),
    getPmsBookings: vi.fn(),
    getPmsBookingRequests: vi.fn(),
}));

const mockDisconnectedIntegration: PmsIntegration = {
    business_id: 42,
    provider: 'bnovo',
    mode: 'read_only',
    connection_status: 'not_configured',
    credentials_configured: false,
    enabled: true,
    masked_account: null,
    external_hotel_id: null,
    currency: 'RUB',
    webhook_status: 'not_configured',
    last_sync_at: null,
    mappings: {
        available_room_types: [],
        available_tariffs: [],
    },
};

const mockConnectedIntegration: PmsIntegration = {
    business_id: 42,
    provider: 'bnovo',
    mode: 'read_only',
    connection_status: 'connected',
    credentials_configured: true,
    enabled: true,
    masked_account: 'acc***123',
    external_hotel_id: 'hotel_77',
    currency: 'RUB',
    webhook_status: 'active',
    last_sync_at: '2026-10-21T18:00:00Z',
    mappings: {
        available_room_types: [
            { id: '101', name: 'Стандарт' },
            { id: '102', name: 'Люкс' },
        ],
        available_tariffs: [
            { id: 't1', name: 'Базовый тариф' },
        ],
    },
};

const mockBookings: PmsBooking[] = [
    {
        business_id: 42,
        provider: 'bnovo',
        booking_id: 'booking_1',
        booking_number: 'BN-9090',
        customer_name: 'Иван Иванов',
        arrival: '2026-10-25T14:00:00Z',
        departure: '2026-10-28T12:00:00Z',
        amount: 15000,
        currency: 'RUB',
        status: 'confirmed',
    },
];

const renderPanel = (businessId = 42, canManage = true) =>
    render(
        <MemoryRouter>
            <BnovoIntegrationPanel businessId={businessId} canManage={canManage} />
        </MemoryRouter>
    );

describe('BnovoIntegrationPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPmsIntegration).mockResolvedValue({
            success: true,
            businessId: 42,
            pms: mockDisconnectedIntegration,
        });
        vi.mocked(getPmsBookings).mockResolvedValue({
            success: true,
            businessId: 42,
            bookings: [],
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('renders empty form when Bnovo is disconnected', async () => {
        renderPanel();

        expect(await screen.findByText('Bnovo')).toBeDefined();
        expect(screen.getByText('Не подключено')).toBeDefined();
        expect(screen.getByPlaceholderText('ID аккаунта из Bnovo Octopus')).toBeDefined();
        expect(screen.getByPlaceholderText('Пароль API из настроек Bnovo')).toBeDefined();
        expect(screen.getByPlaceholderText('Определится при проверке подключения')).toBeDefined();
    });

    it('submits configuration form and updates state', async () => {
        vi.mocked(configurePmsIntegration).mockResolvedValueOnce({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });

        renderPanel();

        const accountInput = await screen.findByPlaceholderText('ID аккаунта из Bnovo Octopus');
        const passwordInput = screen.getByPlaceholderText('Пароль API из настроек Bnovo');
        const hotelInput = screen.getByPlaceholderText('Определится при проверке подключения');

        fireEvent.change(accountInput, { target: { value: 'acc_demo' } });
        fireEvent.change(passwordInput, { target: { value: 'secretpass' } });
        fireEvent.change(hotelInput, { target: { value: 'hotel_99' } });

        const saveButton = screen.getByRole('button', { name: /Сохранить настройки/i });
        fireEvent.click(saveButton);

        await waitFor(() => {
            expect(configurePmsIntegration).toHaveBeenCalledWith(42, {
                account_id: 'acc_demo',
                api_password: 'secretpass',
                external_hotel_id: 'hotel_99',
                currency: 'RUB',
                enabled: true,
            });
        });

        expect(await screen.findByText(/Настройки Bnovo успешно сохранены/i)).toBeDefined();
    });

    it('tests connection via button', async () => {
        vi.mocked(getPmsIntegration).mockResolvedValue({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });
        vi.mocked(testPmsIntegration).mockResolvedValueOnce({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });

        renderPanel();

        const testButton = await screen.findByRole('button', { name: /Проверить подключение/i });
        fireEvent.click(testButton);

        await waitFor(() => {
            expect(testPmsIntegration).toHaveBeenCalledWith(42);
        });

        expect(await screen.findByText(/Подключение проверено/i)).toBeDefined();
    });

    it('enqueues manual sync', async () => {
        vi.mocked(getPmsIntegration).mockResolvedValue({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });
        vi.mocked(syncPmsIntegration).mockResolvedValueOnce({
            success: true,
            businessId: 42,
            queued: 1,
        });

        renderPanel();

        const syncButton = await screen.findByRole('button', { name: /Синхронизировать/i });
        fireEvent.click(syncButton);

        await waitFor(() => {
            expect(syncPmsIntegration).toHaveBeenCalledWith(42);
        });

        expect(await screen.findByText(/Синхронизация поставлена в очередь/i)).toBeDefined();
    });

    it('connects webhooks', async () => {
        vi.mocked(getPmsIntegration).mockResolvedValue({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });
        vi.mocked(connectPmsWebhooks).mockResolvedValueOnce({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });

        renderPanel();

        const webhooksButton = await screen.findByRole('button', { name: /Включить автоматические обновления/i });
        fireEvent.click(webhooksButton);

        await waitFor(() => {
            expect(connectPmsWebhooks).toHaveBeenCalledWith(42);
        });

        expect(await screen.findByText(/Автоматические обновления подключены/i)).toBeDefined();
    });

    it('renders room types and tariffs and allows loading bookings', async () => {
        vi.mocked(getPmsIntegration).mockResolvedValue({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });
        vi.mocked(getPmsBookings).mockResolvedValue({
            success: true,
            businessId: 42,
            bookings: mockBookings,
        });

        renderPanel();

        expect(await screen.findByText('Категории номеров (2)')).toBeDefined();
        expect(screen.getByText('Тарифы (1)')).toBeDefined();
        expect(screen.getByText('Стандарт')).toBeDefined();
        expect(screen.getByText('Люкс')).toBeDefined();
        expect(screen.getByText('Базовый тариф')).toBeDefined();

        const showBookingsBtn = screen.getByRole('button', { name: /Показать бронирования Bnovo/i });
        fireEvent.click(showBookingsBtn);

        await waitFor(() => {
            expect(getPmsBookings).toHaveBeenCalledWith(42, 30);
        });

        expect(await screen.findByText('Иван Иванов')).toBeDefined();
        expect(screen.getByText('15000 RUB')).toBeDefined();
        expect(screen.getByText('BN-9090')).toBeDefined();
    });

    it('handles disconnect flow with confirmation', async () => {
        vi.mocked(getPmsIntegration).mockResolvedValue({
            success: true,
            businessId: 42,
            pms: mockConnectedIntegration,
        });
        vi.mocked(disconnectPmsIntegration).mockResolvedValueOnce({
            success: true,
            businessId: 42,
            deleted: true,
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        renderPanel();

        const disconnectBtn = await screen.findByRole('button', { name: /Отключить Bnovo/i });
        fireEvent.click(disconnectBtn);

        await waitFor(() => {
            expect(window.confirm).toHaveBeenCalled();
            expect(disconnectPmsIntegration).toHaveBeenCalledWith(42);
        });

        expect(await screen.findByText(/Интеграция с Bnovo отключена/i)).toBeDefined();
    });
    it('hides raw provider failures and lets the owner retry loading safely', async () => {
        vi.mocked(getPmsIntegration).mockRejectedValueOnce({ response: { data: {code:'BNOVO_FAILURE',message:'Authorization: Bearer private-secret-token'} } });
        renderPanel();
        const error=await screen.findByRole('alert');
        expect(error.textContent).not.toContain('private-secret-token');
        expect(screen.getByRole('button',{name:'Сохранить настройки'}).hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('button',{name:'Обновить подключение'}));
        await waitFor(()=>expect(screen.getByRole('button',{name:'Сохранить настройки'}).hasAttribute('disabled')).toBe(false));
        expect(screen.queryByRole('alert')).toBeNull();
    });

});
