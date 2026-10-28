// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ExternalSipSettings from './ExternalSipSettings';
import * as api from '../api/telephony';
import type { ExternalSipTrunk, Operation, Telephony } from '../api/telephony';
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ userId: 'owner-1' }) }));
vi.mock('../api/telephony', () => ({ createExternalSip: vi.fn(), updateExternalSip: vi.fn(), checkExternalSip: vi.fn(),
    disconnectExternalSip: vi.fn(), getExternalSipRequest: vi.fn(), getPhoneOperation: vi.fn(), getTelephony: vi.fn(), setPrimaryPhone: vi.fn() }));
const op: Operation = { id: 'job-1', phoneId: 'phone-1', kind: 'external_apply', stage: 'external_validate', state: 'pending', errorCode: null, result: null };
const trunk: ExternalSipTrunk = { id: 'phone-1', number: '79990000001', host: 'sip.provider.ru', port: 5060,
    transport: 'udp', loginMasked: '••••user', passwordConfigured: true, revision: 3, state: 'active', registration: 'registered', inboundVerifiedAt: null, outboundVerifiedAt: null };
const overview = (extra: Partial<Telephony> = {}): Telephony => ({ success: true, businessId: 7, canManage: true, canPurchase: false,
    managedMode: false, pilotEnabled: true, balanceReady: true, numbers: [], orders: [], remainingSeconds: 100,
    limits: { numbers: 3, dailySeconds: 100 }, notices: [], externalSip: { available: true, transports: ['udp', 'tcp'] }, externalTrunks: [], ...extra });
const changed = vi.fn();
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); vi.mocked(api.createExternalSip).mockResolvedValue(op);
    vi.mocked(api.updateExternalSip).mockResolvedValue(op); vi.mocked(api.checkExternalSip).mockResolvedValue(op);
    vi.mocked(api.disconnectExternalSip).mockResolvedValue(op); vi.mocked(api.getPhoneOperation).mockResolvedValue(op); });
afterEach(cleanup);
function fill() {
    fireEvent.click(screen.getByRole('button', { name: 'Подключить своего оператора' }));
    for (const [name, value] of [['Номер компании', '+79990000001'], ['SIP-сервер', 'sip.provider.ru'], ['Логин SIP', 'test-user'], ['Пароль SIP', 'SyntheticOnly!']]) {
        fireEvent.change(screen.getByLabelText(name), { target: { value } });
    }
}
it('accepts an asynchronous request only after canonical operation readback; never stores credentials', async () => {
    render(<ExternalSipSettings businessId={7} data={overview()} onChanged={changed} />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    await screen.findByRole('status');
    expect(api.createExternalSip).toHaveBeenCalledWith(7, { number: '+79990000001', host: 'sip.provider.ru', port: 5060,
        transport: 'udp', login: 'test-user', password: 'SyntheticOnly!' }, expect.any(String), expect.any(AbortSignal));
    expect(api.getPhoneOperation).toHaveBeenCalledWith(7, 'job-1', expect.any(AbortSignal));
    expect(screen.getByRole('status').textContent).toContain('Запрос принят');
    expect(screen.queryByText('Подключён', { exact: true })).toBeNull();
    expect(sessionStorage.length).toBe(0); expect(changed).toHaveBeenCalledTimes(1);
});
it('recovers a lost acknowledgment by request key across remounts without replaying a create', async () => {
    vi.mocked(api.createExternalSip).mockRejectedValueOnce(new Error('lost ack'));
    const view = render(<ExternalSipSettings businessId={7} data={overview()} onChanged={changed} />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    await screen.findByRole('button', { name: 'Проверить результат' });
    const saved = JSON.parse(sessionStorage.getItem('ava:sip-request:owner-1:7')!);
    expect(Object.keys(saved).sort()).toEqual(['key', 'kind']); expect(saved.kind).toBe('create');
    expect(JSON.stringify(saved)).not.toMatch(/SyntheticOnly|test-user|provider/);
    view.unmount(); vi.mocked(api.getExternalSipRequest).mockResolvedValue({ success: true, businessId: 7, operation: op });
    render(<ExternalSipSettings businessId={7} data={overview()} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить результат' }));
    await screen.findByRole('status');
    expect(api.getExternalSipRequest).toHaveBeenCalledWith(7, saved.key, expect.any(AbortSignal));
    expect(api.createExternalSip).toHaveBeenCalledTimes(1); expect(sessionStorage.length).toBe(0);
});
it('keeps recovery pending on a foreign business readback', async () => {
    sessionStorage.setItem('ava:sip-request:owner-1:7', JSON.stringify({ key: '11111111-1111-4111-a111-111111111111', kind: 'create' }));
    vi.mocked(api.getExternalSipRequest).mockResolvedValue({ success: true, businessId: 8, operation: op });
    render(<ExternalSipSettings businessId={7} data={overview()} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Проверить результат' }));
    await screen.findByRole('alert'); expect(sessionStorage.length).toBe(1); expect(changed).not.toHaveBeenCalled();
});
it('edits only changed fields with a revision and retains credentials when left blank', async () => {
    render(<ExternalSipSettings businessId={7} data={overview({ externalTrunks: [trunk] })} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Изменить подключение' }));
    expect((screen.getByLabelText('Пароль SIP') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Порт'), { target: { value: '5061' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить подключение' }));
    await screen.findByRole('status');
    expect(api.updateExternalSip).toHaveBeenCalledWith(7, trunk.id, { port: 5061, expectedRevision: 3 }, expect.any(String), expect.any(AbortSignal));
});
it('blocks a stale form and does not leak form or pending requests into another business', async () => {
    const view = render(<ExternalSipSettings businessId={7} data={overview({ externalTrunks: [trunk] })} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Изменить подключение' }));
    view.rerender(<ExternalSipSettings businessId={7} data={overview({ externalTrunks: [{ ...trunk, revision: 4 }] })} onChanged={changed} />);
    expect((screen.getByRole('button', { name: 'Сохранить подключение' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ExternalSipSettings businessId={8} data={overview({ businessId: 8 })} onChanged={changed} />);
    expect(screen.queryByLabelText('Пароль SIP')).toBeNull(); expect(api.updateExternalSip).not.toHaveBeenCalled();
});
it('offers read-only status to managers without owner writes', () => {
    render(<ExternalSipSettings businessId={7} data={overview({ canManage: false, externalTrunks: [trunk] })} onChanged={changed} />);
    expect(screen.getByText('Связь с оператором установлена')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Изменить подключение' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Подключить своего оператора' })).toBeNull();
});
it('requires a separate confirmation before disconnect and uses the current revision', async () => {
    render(<ExternalSipSettings businessId={7} data={overview({ externalTrunks: [trunk] })} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Отключить' })); expect(api.disconnectExternalSip).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' })); expect(api.disconnectExternalSip).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Отключить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить отключение' })); await screen.findByRole('status');
    expect(api.disconnectExternalSip).toHaveBeenCalledWith(7, trunk.id, 3, expect.any(String), expect.any(AbortSignal));
});
it('retains compatibility with the old overview and handles an unavailable host without a fake connect button', () => {
    const view = render(<ExternalSipSettings businessId={7} data={overview({ externalSip: undefined })} onChanged={changed} />);
    expect(screen.queryByRole('heading', { name: 'Своя телефония' })).toBeNull();
    view.rerender(<ExternalSipSettings businessId={7} data={overview({ externalSip: { available: false, transports: [] } })} onChanged={changed} />);
    expect(screen.queryByRole('button', { name: 'Подключить своего оператора' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить проверку' })); expect(changed).toHaveBeenCalledTimes(1);
});
