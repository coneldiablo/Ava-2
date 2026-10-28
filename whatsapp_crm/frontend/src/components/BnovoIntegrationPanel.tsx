import { useEffect, useState, type FormEvent } from 'react';
import { Check, CircleAlert, Layers, Tag, Calendar } from 'lucide-react';
import {
    getPmsIntegration,
    configurePmsIntegration,
    disconnectPmsIntegration,
    testPmsIntegration,
    syncPmsIntegration,
    connectPmsWebhooks,
    getPmsBookings,
    type PmsIntegration,
    type PmsBooking
} from '../api';

const statusLabels: Record<string, string> = {
    not_configured: 'Не подключено',
    not_tested: 'Настройки сохранены, связь не проверена',
    connected: 'Подключено',
    connected_limited: 'Подключено (каталог ограничен)',
    error: 'Ошибка подключения',
    disconnected: 'Отключено',
};

const webhookLabels: Record<string, string> = {
    not_configured: 'Не настроены',
    healthy: 'Подключены и активны',
    activation_pending: 'Активация (до 24 часов)',
    receiving: 'Изменения поступают в AVA',
    configuration_error: 'Ошибка регистрации',
};

function formatPmsError(error: unknown): string {
    const response = error as { response?: { data?: { error?: string; code?: string; message?: string } } };
    const code = response.response?.data?.code || response.response?.data?.error;

    const messages: Record<string, string> = {
        BNOVO_CREDENTIALS_REQUIRED: 'Укажите числовой ID аккаунта и пароль API из Bnovo.',
        BNOVO_AUTH_FAILED: 'Неверный ID аккаунта или пароль API. Проверьте реквизиты в личном кабинете Bnovo.',
        BNOVO_HOTEL_SELECTION_REQUIRED: 'В аккаунте несколько отелей. Укажите ID нужного отеля.',
        PMS_CONNECTION_CHANGED: 'Настройки изменились. Обновите подключение и повторите действие.',
        BNOVO_HOTEL_ID_UNAVAILABLE: 'Не удалось определить отель по списку категорий Bnovo.',
        BNOVO_HOTEL_SCOPE_MISMATCH: 'Указанный ID отеля не принадлежит этому аккаунту Bnovo.',
        PMS_PUBLIC_URL_REQUIRED: 'Для вебхуков требуется настроенный публичный HTTPS-адрес сервера.',
        PMS_WEBHOOK_CONFIGURATION_ERROR: 'Не удалось зарегистрировать вебхуки в Bnovo. Проверьте права API-аккаунта.',
        PMS_NOT_CONFIGURED: 'Интеграция PMS ещё не настроена. Сначала сохраните данные подключения.',
    };

    if (code && messages[code]) return messages[code];
    return 'Не удалось выполнить операцию Bnovo. Проверьте соединение и попробуйте снова.';
}

export default function BnovoIntegrationPanel({
    businessId,
    canManage,
}: {
    businessId: number;
    canManage: boolean;
}) {
    const [pms, setPms] = useState<PmsIntegration | null>(null);
    const [busy, setBusy] = useState<string>('');
    const [error, setError] = useState<string>('');
    const [feedback, setFeedback] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [stateLoaded, setStateLoaded] = useState(false);

    // Form fields
    const [accountId, setAccountId] = useState('');
    const [apiPassword, setApiPassword] = useState('');
    const [externalHotelId, setExternalHotelId] = useState('');
    const [currency, setCurrency] = useState('RUB');
    const [enabled, setEnabled] = useState(true);

    // Bookings state
    const [bookings, setBookings] = useState<PmsBooking[] | null>(null);
    const [bookingsLoading, setBookingsLoading] = useState(false);
    const [showBookings, setShowBookings] = useState(false);

    const load = async (restore = false) => {
        setLoading(true);
        try {
            const res = await getPmsIntegration(businessId);
            if (res.success) {
                setStateLoaded(true);setError('');
                setPms(res.pms);
                if (res.pms && restore) {
                    setExternalHotelId(res.pms.external_hotel_id || '');
                    setCurrency(res.pms.currency || 'RUB');
                    setEnabled(res.pms.enabled ?? true);
                }
            } else { throw new Error('PMS_READ_FAILED'); }
        } catch (e) {
            setError(formatPmsError(e));
        } finally { setLoading(false); }
    };

    useEffect(() => {
        setError('');
        setFeedback('');
        setAccountId('');
        setApiPassword('');
        setBookings(null);
        setShowBookings(false);
        void load(true);
    }, [businessId]);

    const handleSave = async (e: FormEvent) => {
        e.preventDefault();
        if (!canManage || busy || loading || !stateLoaded) return;

        setError('');
        setFeedback('');
        setBusy('save');
        try {
            const payload: {
                account_id?: string;
                api_password?: string;
                external_hotel_id?: string;
                currency?: string;
                enabled?: boolean;
            } = {
                currency,
                enabled,
            };

            if (accountId.trim()) payload.account_id = accountId.trim();
            if (apiPassword.trim()) payload.api_password = apiPassword.trim();
            if (externalHotelId.trim()) payload.external_hotel_id = externalHotelId.trim();

            const res = await configurePmsIntegration(businessId, payload);
            if (!res.success) throw new Error('save_failed');

            setPms(res.pms);
            setApiPassword('');
            setFeedback('Настройки Bnovo успешно сохранены. Теперь нажмите «Проверить подключение».');
            await load();
        } catch (err) {
            setError(formatPmsError(err));
        } finally {
            setBusy('');
        }
    };

    const handleTest = async () => {
        if (!canManage || busy || loading || !stateLoaded) return;
        setError('');
        setFeedback('');
        setBusy('test');
        try {
            const res = await testPmsIntegration(businessId);
            if (!res.success) throw new Error('test_failed');

            setPms(res.pms);
            if (res.pms.external_hotel_id) {
                setExternalHotelId(res.pms.external_hotel_id);
            }
            setFeedback(res.pms.connection_status === 'connected_limited'
                ? 'Подключение проверено. Доступ к категориям и тарифам ограничен настройками вашего аккаунта Bnovo.'
                : 'Подключение проверено. Категории номеров и тарифы обновлены.');
        } catch (err) {
            setError(formatPmsError(err));
        } finally {
            setBusy('');
        }
    };

    const handleSync = async () => {
        if (!canManage || busy || loading || !stateLoaded) return;
        setError('');
        setFeedback('');
        setBusy('sync');
        try {
            const res = await syncPmsIntegration(businessId);
            if (!res.success) throw new Error('sync_failed');

            setFeedback(`Синхронизация поставлена в очередь (задач: ${res.queued}). Бронирования загружаются в AVA.`);
            await load();
        } catch (err) {
            setError(formatPmsError(err));
        } finally {
            setBusy('');
        }
    };

    const handleWebhooks = async () => {
        if (!canManage || busy || loading || !stateLoaded) return;
        setError('');
        setFeedback('');
        setBusy('webhooks');
        try {
            const res = await connectPmsWebhooks(businessId);
            if (!res.success) throw new Error('webhooks_failed');

            setPms(res.pms);
            setFeedback('Автоматические обновления подключены. Bnovo может активировать их в течение суток.');
        } catch (err) {
            setError(formatPmsError(err));
        } finally {
            setBusy('');
        }
    };

    const handleDisconnect = async () => {
        if (!canManage || busy || loading || !stateLoaded) return;
        if (!window.confirm('Отключить Bnovo? Учётные данные будут удалены. Сохранённые диалоги и клиенты останутся в AVA.')) {
            return;
        }

        setError('');
        setFeedback('');
        setBusy('disconnect');
        try {
            const res = await disconnectPmsIntegration(businessId);
            if (!res.success) throw new Error('disconnect_failed');

            setPms(null);
            setAccountId('');
            setApiPassword('');
            setExternalHotelId('');
            setBookings(null);
            setShowBookings(false);
            setFeedback('Интеграция с Bnovo отключена, учётные данные удалены.');
        } catch (err) {
            setError(formatPmsError(err));
        } finally {
            setBusy('');
        }
    };

    const loadBookings = async () => {
        setBookingsLoading(true);
        try {
            const res = await getPmsBookings(businessId, 30);
            if (res.success) {
                setBookings(res.bookings || []);
                setShowBookings(true);
            }
        } catch (err) {
            setError(formatPmsError(err));
        } finally {
            setBookingsLoading(false);
        }
    };

    const isConnected = pms?.connection_status === 'connected' || pms?.connection_status === 'connected_limited';
    const isConfigured = Boolean(pms?.credentials_configured);
    const roomTypes = pms?.mappings?.available_room_types || [];
    const tariffs = pms?.mappings?.available_tariffs || [];

    return (
        <section id="ava-channel-panel" className="ava-channel-config" aria-labelledby="bnovo-title" aria-busy={loading || Boolean(busy)}>
            <div>
                <p className="ava-channels-kicker">БРОНИРОВАНИЯ</p>
                <h2 id="bnovo-title">Bnovo</h2>
                <p>
                    Подключите Bnovo, чтобы AVA учитывала ваши бронирования, категории номеров и тарифы.
                    Новые заявки поступают менеджеру; подтверждённые брони остаются под вашим контролем.
                </p>

                {isConfigured && (
                    <div style={{ marginTop: '20px', padding: '14px', borderRadius: '14px', background: 'rgba(255,255,255,0.7)', border: '1px solid var(--neu-border)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', fontSize: '13px' }}>
                            <div>
                                <span style={{ color: 'var(--text-secondary)', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Аккаунт</span>
                                <strong>{pms?.masked_account || '—'}</strong>
                            </div>
                            <div>
                                <span style={{ color: 'var(--text-secondary)', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>ID отеля Bnovo</span>
                                <strong>{pms?.external_hotel_id || 'Автоопределение'}</strong>
                            </div>
                            <div>
                                <span style={{ color: 'var(--text-secondary)', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Валюта</span>
                                <strong>{pms?.currency || 'RUB'}</strong>
                            </div>
                            <div>
                                <span style={{ color: 'var(--text-secondary)', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Обновления</span>
                                <strong>{webhookLabels[pms?.webhook_status || 'not_configured'] || 'Не настроены'}</strong>
                            </div>
                        </div>

                        {pms?.last_sync_at && (
                            <p style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                Последняя синхронизация: {new Date(pms.last_sync_at).toLocaleString('ru-RU')}
                            </p>
                        )}
                    </div>
                )}
            </div>

            <div style={{ minWidth: 0 }}>
                <ol className="ava-channel-steps" aria-label="Этапы подключения Bnovo">
                    <li className={isConfigured ? 'is-complete' : 'is-current'}>
                        <span>1</span><strong>Реквизиты Bnovo</strong>
                    </li>
                    <li className={isConnected ? 'is-complete' : isConfigured ? 'is-current' : ''}>
                        <span>2</span><strong>Проверка связи</strong>
                    </li>
                    <li className={pms?.last_sync_at ? 'is-complete' : isConnected ? 'is-current' : ''}>
                        <span>3</span><strong>Синхронизация</strong>
                    </li>
                </ol>

                <div style={{ marginTop: '18px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 600 }}>
                    <span>Статус подключения:</span>
                    <span
                        className={`ava-channel-state ${isConnected ? 'is-connected' : ''}`}
                        style={{ margin: 0, padding: '4px 10px', borderRadius: '8px', background: isConnected ? 'rgba(23,104,55,0.1)' : 'rgba(136,91,13,0.1)' }}
                    >
                        {isConnected ? <Check size={14} /> : <CircleAlert size={14} />}
                        {statusLabels[pms?.connection_status || 'not_configured'] || 'Не подключено'}
                    </span>
                </div>

                <div className="ava-channel-actions">
                    <button type="button" disabled={loading || Boolean(busy)} onClick={()=>void load(true)}>
                        {loading ? 'Проверяем…' : 'Обновить подключение'}
                    </button>
                </div>
                {error && (
                    <p role="alert" className="ava-whatsapp-error" style={{ marginTop: '14px', padding: '12px', borderRadius: '12px', background: 'rgba(255,239,240,0.85)' }}>
                        {error}
                    </p>
                )}

                {feedback && (
                    <p role="status" className="ava-channel-feedback" style={{ marginTop: '14px' }}>
                        {feedback}
                    </p>
                )}

                {canManage ? (
                    <form onSubmit={handleSave} style={{ marginTop: '20px' }} aria-busy={Boolean(busy)}>
                        <div className="ava-channel-fields">
                            <label>
                                <span>ID аккаунта Bnovo</span>
                                <input
                                    type="text"
                                    required={!isConfigured}
                                    placeholder={pms?.masked_account ? `${pms.masked_account} (введите для смены)` : 'ID аккаунта из Bnovo Octopus'}
                                    value={accountId}
                                    onChange={(e) => setAccountId(e.target.value)}
                                    disabled={Boolean(busy) || loading || !stateLoaded}
                                />
                            </label>

                            <label>
                                <span>API-пароль Bnovo</span>
                                <input
                                    type="password"
                                    required={!isConfigured}
                                    placeholder={isConfigured ? '•••••••• (оставьте пустым, чтобы не менять)' : 'Пароль API из настроек Bnovo'}
                                    value={apiPassword}
                                    onChange={(e) => setApiPassword(e.target.value)}
                                    autoComplete="new-password"
                                    disabled={Boolean(busy) || loading || !stateLoaded}
                                />
                            </label>

                            <label>
                                <span>ID отеля в Bnovo (необязательно)</span>
                                <input
                                    type="text"
                                    placeholder="Определится при проверке подключения"
                                    value={externalHotelId}
                                    onChange={(e) => setExternalHotelId(e.target.value)}
                                    disabled={Boolean(busy) || loading || !stateLoaded}
                                />
                            </label>

                            <label>
                                <span>Валюта</span>
                                <select
                                    aria-label="Валюта отеля"
                                    value={currency}
                                    onChange={(e) => setCurrency(e.target.value)}
                                    disabled={Boolean(busy) || loading || !stateLoaded}
                                    style={{
                                        minWidth: 0,
                                        width: '100%',
                                        height: '46px',
                                        padding: '0 14px',
                                        borderRadius: '12px',
                                        border: '1px solid rgba(17,17,17,.18)',
                                        color: 'var(--text-primary)',
                                        background: 'rgba(255,255,255,.9)',
                                        fontSize: '15px',
                                    }}
                                >
                                    <option value="RUB">RUB — Российский рубль</option>
                                    <option value="USD">USD — Доллар США</option>
                                    <option value="EUR">EUR — Евро</option>
                                    <option value="KZT">KZT — Казахстанский тенге</option>
                                    <option value="BYN">BYN — Белорусский рубль</option>
                                </select>
                            </label>
                        </div>

                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={enabled}
                                onChange={(e) => setEnabled(e.target.checked)}
                                disabled={Boolean(busy) || loading || !stateLoaded}
                            />
                            <span>Включить синхронизацию Bnovo</span>
                        </label>

                        <div className="ava-channel-actions">
                            <button type="submit" className="ava-channel-primary" disabled={Boolean(busy) || loading || !stateLoaded}>
                                {busy === 'save' ? 'Сохраняем…' : 'Сохранить настройки'}
                            </button>

                            <button
                                type="button"
                                onClick={handleTest}
                                disabled={Boolean(busy) || loading || !stateLoaded || !isConfigured}
                            >
                                {busy === 'test' ? 'Проверяем…' : 'Проверить подключение'}
                            </button>

                            {isConnected && (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleSync}
                                        disabled={Boolean(busy) || loading || !stateLoaded}
                                    >
                                        {busy === 'sync' ? 'Ставим в очередь…' : 'Синхронизировать'}
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handleWebhooks}
                                        disabled={Boolean(busy) || loading || !stateLoaded}
                                    >
                                        {busy === 'webhooks' ? 'Подключаем…' : 'Включить автоматические обновления'}
                                    </button>
                                </>
                            )}

                            {isConfigured && (
                                <button
                                    type="button"
                                    className="ava-channel-disconnect"
                                    onClick={handleDisconnect}
                                    disabled={Boolean(busy) || loading || !stateLoaded}
                                >
                                    Отключить Bnovo
                                </button>
                            )}
                        </div>
                    </form>
                ) : (
                    <p className="ava-channel-hint" style={{ marginTop: '16px' }}>
                        Настройками подключения управляет владелец бизнеса.
                    </p>
                )}

                {/* Categories & Tariffs section */}
                {roomTypes.length > 0 && (
                    <div style={{ marginTop: '24px', padding: '16px', borderRadius: '16px', background: 'rgba(255,255,255,0.6)', border: '1px solid var(--neu-border)' }}>
                        <h3 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', margin: '0 0 10px' }}>
                            <Layers size={17} /> Категории номеров ({roomTypes.length})
                        </h3>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {roomTypes.map((rt) => (
                                <span
                                    key={rt.id}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        padding: '4px 10px',
                                        borderRadius: '8px',
                                        background: '#fff',
                                        border: '1px solid var(--neu-border)',
                                        fontSize: '12px',
                                        fontWeight: 600,
                                    }}
                                >
                                    <span style={{ color: 'var(--text-secondary)' }}>#{rt.id}</span> {rt.name}
                                </span>
                            ))}
                        </div>

                        {tariffs.length > 0 && (
                            <>
                                <h3 style={{ fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', margin: '16px 0 10px' }}>
                                    <Tag size={17} /> Тарифы ({tariffs.length})
                                </h3>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                                    {tariffs.map((t) => (
                                        <span
                                            key={t.id}
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: '4px',
                                                padding: '4px 10px',
                                                borderRadius: '8px',
                                                background: '#fff',
                                                border: '1px solid var(--neu-border)',
                                                fontSize: '12px',
                                                fontWeight: 600,
                                            }}
                                        >
                                            <span style={{ color: 'var(--text-secondary)' }}>#{t.id}</span> {t.name}
                                        </span>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* Bookings viewer */}
                {isConnected && canManage && (
                    <div style={{ marginTop: '20px' }}>
                        <button
                            type="button"
                            onClick={() => {
                                if (showBookings) setShowBookings(false);
                                else void loadBookings();
                            }}
                            disabled={bookingsLoading}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                minHeight: '44px',
                                padding: '0 16px',
                                borderRadius: '10px',
                                border: '1px solid var(--neu-border)',
                                background: '#fff',
                                fontSize: '13px',
                                fontWeight: 650,
                                cursor: 'pointer',
                            }}
                        >
                            <Calendar size={15} />
                            {bookingsLoading ? 'Загрузка…' : showBookings ? 'Скрыть бронирования Bnovo' : 'Показать бронирования Bnovo'}
                        </button>

                        {showBookings && bookings && (
                            <div style={{ marginTop: '12px', border: '1px solid var(--neu-border)', borderRadius: '14px', background: '#fff', overflow: 'hidden' }}>
                                {bookings.length === 0 ? (
                                    <p style={{ padding: '20px', margin: 0, color: 'var(--text-secondary)', textAlign: 'center' }}>
                                        Синхронизированных бронирований пока нет. Нажмите «Синхронизировать».
                                    </p>
                                ) : (
                                    <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                                            <thead>
                                                <tr style={{ background: 'rgba(0,0,0,0.03)', borderBottom: '1px solid var(--neu-border)' }}>
                                                    <th style={{ padding: '8px 12px' }}>№ Брони</th>
                                                    <th style={{ padding: '8px 12px' }}>Гость</th>
                                                    <th style={{ padding: '8px 12px' }}>Заезд</th>
                                                    <th style={{ padding: '8px 12px' }}>Выезд</th>
                                                    <th style={{ padding: '8px 12px' }}>Сумма</th>
                                                    <th style={{ padding: '8px 12px' }}>Статус</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {bookings.map((b) => (
                                                    <tr key={b.booking_id} style={{ borderBottom: '1px solid var(--neu-border)' }}>
                                                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{b.booking_number || b.booking_id}</td>
                                                        <td style={{ padding: '8px 12px' }}>{b.customer_name || [b.customer?.name,b.customer?.surname].filter(Boolean).join(' ') || '—'}</td>
                                                        <td style={{ padding: '8px 12px' }}>{b.arrival ? new Date(b.arrival).toLocaleDateString('ru-RU') : '—'}</td>
                                                        <td style={{ padding: '8px 12px' }}>{b.departure ? new Date(b.departure).toLocaleDateString('ru-RU') : '—'}</td>
                                                        <td style={{ padding: '8px 12px' }}>{b.amount != null ? `${b.amount} ${b.currency || 'RUB'}` : '—'}</td>
                                                        <td style={{ padding: '8px 12px' }}>
                                                            <span style={{ padding: '2px 8px', borderRadius: '6px', fontSize: '11px', background: 'rgba(0,0,0,0.05)', fontWeight: 600 }}>
                                                                {b.status || 'Синхронизировано'}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
