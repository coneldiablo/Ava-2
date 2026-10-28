import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronRight, CircleAlert, Instagram, Mail, MessageCircle, Phone, RefreshCw, Send, Zap } from 'lucide-react';
import ExternalIntegrationPanel from '../components/ExternalIntegrationPanel';
import BnovoIntegrationPanel from '../components/BnovoIntegrationPanel';
import WhatsAppResponseSettings from '../components/WhatsAppResponseSettings';
import VoiceSettings from '../components/VoiceSettings';
import TelephonyPanel from '../components/TelephonyPanel';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import { connectWhatsApp, disconnectChannel, getChannelStatus, getOpenWaQR, getOpenWaStatus, logoutOpenWa, replaceWhatsApp, saveChannelConfig, testEmail, testMax, testTelegram, testVk } from '../api';
import InstagramConnectionPanel from '../components/InstagramConnectionPanel';
import './Channels.css';

type ConfigChannelKey = 'telegram' | 'email' | 'vk' | 'max';
type ChannelKey = ConfigChannelKey | 'whatsapp' | 'instagram' | 'telephony' | 'amocrm' | 'avito' | 'bnovo';
const channelFromQuery = (search: string): ChannelKey | null => {
    const channel = new URLSearchParams(search).get('channel') || new URLSearchParams(search).get('integration');
    return ['whatsapp', 'instagram', 'telephony', 'telegram', 'email', 'vk', 'max', 'amocrm', 'avito', 'bnovo'].includes(channel || '') ? channel as ChannelKey : null;
};
type ChannelStatus = {
    whatsapp: boolean; whatsappConfigured?: boolean; telegram: boolean; email: boolean; vk: boolean; max: boolean;
    instagram?: boolean; instagramConfigured?: boolean; instagramInboundConfirmed?: boolean;
    instagramState?: 'disabled' | 'not_connected' | 'awaiting_inbound' | 'connected' | 'paused';
    bnovo?: boolean; bnovoConfigured?: boolean; bnovoStatus?: string; bnovoExternalHotelId?: string | null; bnovoMaskedAccount?: string | null;
    telegramConfigured?: boolean; emailConfigured?: boolean; emailSmtpVerified?: boolean; emailImapConfigured?: boolean;
    emailImapVerified?: boolean; emailImapMailboxVerified?: boolean; emailImapPolling?: boolean; emailReceiving?: boolean; vkConfigured?: boolean; maxConfigured?: boolean;
    telegramBotUsername?: string | null; emailAddress?: string | null; vkGroupName?: string | null; maxBotName?: string | null;
};
type Field = { key: string; label: string; placeholder?: string; secret?: boolean; type?: string };
const configs: Record<ConfigChannelKey, { title: string; description: string; fields: Field[] }> = {
    telegram: { title: 'Telegram', description: 'Создайте бота в BotFather и укажите токен. Клиенты смогут писать боту, а ответы появятся в AVA.', fields: [
        { key: 'telegramBotToken', label: 'Токен Telegram-бота', secret: true },
    ] },
    email: { title: 'Электронная почта', description: 'SMTP отправляет письма, IMAP принимает входящие. Используйте отдельный пароль приложения.', fields: [
        { key: 'emailSmtpHost', label: 'SMTP-сервер', placeholder: 'smtp.example.ru' },
        { key: 'emailSmtpPort', label: 'SMTP-порт', placeholder: '587', type: 'number' },
        { key: 'emailSmtpUser', label: 'Адрес почты', placeholder: 'hotel@example.ru', type: 'email' },
        { key: 'emailSmtpPass', label: 'SMTP-пароль', secret: true },
        { key: 'emailImapHost', label: 'IMAP-сервер', placeholder: 'imap.example.ru' },
        { key: 'emailImapPort', label: 'IMAP-порт', placeholder: '993', type: 'number' },
        { key: 'emailImapUser', label: 'IMAP-логин', placeholder: 'hotel@example.ru' },
        { key: 'emailImapPass', label: 'IMAP-пароль', secret: true },
        { key: 'emailFromName', label: 'Имя отправителя', placeholder: 'Аллея Resort' },
    ] },
    vk: { title: 'ВКонтакте', description: 'Включите сообщения сообщества и создайте ключ доступа с правом на сообщения.', fields: [
        { key: 'vkGroupId', label: 'ID сообщества', placeholder: '123456789' },
        { key: 'vkGroupToken', label: 'Ключ доступа сообщества', secret: true },
    ] },
    max: { title: 'MAX', description: 'Создайте бота в кабинете MAX и укажите его токен.', fields: [
        { key: 'maxBotToken', label: 'Токен MAX-бота', secret: true },
    ] },
};
type TestResult = { success?: boolean; error?: string; smtpVerified?: boolean; imapConfigured?: boolean; imapVerified?: boolean; imapMailboxVerified?: boolean; imapPolling?: boolean };
const tests: Record<ConfigChannelKey, (id: number) => Promise<TestResult>> = {
    telegram: testTelegram, email: testEmail, vk: testVk, max: testMax,
};
function errorText(error: unknown) {
    const response = error as { response?: { data?: { error?: string; code?: string } } };
    const code = response.response?.data?.code || response.response?.data?.error;
    const messages: Record<string, string> = {
        channel_credentials_invalid: 'Новые данные подключения не прошли проверку. Прежние настройки сохранены. Проверьте токен и повторите попытку.',
        invalid_channel_config_fields: 'Не удалось принять настройки канала. Проверьте заполненные поля и повторите сохранение.',
        invalid_channel_config_value: 'Проверьте заполненные поля: одно из значений некорректно.',
        invalid_channel_port: 'Порт должен быть числом от 1 до 65535.',
        channel_config_failed: 'Не удалось сохранить настройки канала. Попробуйте снова.',
        channel_disconnect_failed: 'Не удалось отключить канал. Проверьте его состояние и повторите попытку.',
        channel_status_failed: 'Не удалось получить состояние каналов. Нажмите «Обновить статус».',
        telegram_connection_failed: 'Не удалось проверить Telegram-бота. Проверьте токен и попробуйте снова.',
        vk_connection_failed: 'Не удалось проверить сообщество ВКонтакте. Проверьте данные подключения.',
        max_connection_failed: 'Не удалось проверить MAX-бота. Проверьте токен и попробуйте снова.',
    };
    return code && messages[code] ? messages[code] : 'Не удалось выполнить действие. Проверьте соединение и попробуйте снова.';
}

export default function Channels() {
    const { currentInstanceId } = useInstance();
    const auth = useAuth();
    const member = auth.memberships.find(item => item.businessId === currentInstanceId);
    return <ScopedChannels key={`${auth.userId || auth.loginName || 'session'}:${currentInstanceId ?? 'none'}:${auth.role}:${member?.role}:${[...(member?.capabilities || [])].sort().join(',')}`} />;
}

function ScopedChannels() {
    const { search } = useLocation();
    const navigate = useNavigate();
    const { currentInstanceId, currentInstance } = useInstance();
    const { role, memberships, permissionsLoading } = useAuth();
    const canEdit = !permissionsLoading && (role === 'platform_admin' || memberships.some(m => m.businessId === currentInstanceId && m.role === 'hotel_owner' && m.capabilities?.includes('business.manage')));
    const [status, setStatus] = useState<ChannelStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [statusUnavailable,setStatusUnavailable] = useState(false);
    const [selected, setSelected] = useState<ChannelKey | null>(() => channelFromQuery(search));
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState('');
    const pending = useRef(false);
    const refresh = useCallback(async () => {
        if (!currentInstanceId) return null;
        setLoading(true);
        try {
            const response = await getChannelStatus(currentInstanceId);
            if (!response.success) throw new Error('status');
            setStatus(response.channels);setStatusUnavailable(false);
            return response.channels as ChannelStatus;
        } catch (error) { setStatusUnavailable(true);setFeedback(errorText(error)); return null; }
        finally { setLoading(false); }
    }, [currentInstanceId]);
    useEffect(() => {
        setStatus(null); setDraft({}); setFeedback('');
        void refresh();
    }, [refresh]);
    useEffect(() => { setSelected(channelFromQuery(search)); }, [search]);
    const choose = (channel: ChannelKey) => {
        if (pending.current) return;
        const next = selected === channel ? null : channel;
        const params = new URLSearchParams(search);
        params.delete('integration');
        if (next) params.set('channel', next); else params.delete('channel');
        setSelected(next); setFeedback('');
        navigate({ search: params.toString() ? `?${params}` : '' });
    };
    const save = async (event: FormEvent) => {
        event.preventDefault();
        if (!currentInstanceId || !configSelected || !canEdit || pending.current) return;
        const selectedFields = new Set(configs[configSelected].fields.map(field => field.key));
        const payload = Object.fromEntries(Object.entries(draft).filter(([key, value]) => selectedFields.has(key) && value.trim() !== ''));
        if (!Object.keys(payload).length) { setFeedback('Заполните хотя бы одно поле. Пустые поля не меняют действующие настройки.'); return; }
        pending.current = true; setBusy(true); setFeedback('');
        try {
            const result = await saveChannelConfig(currentInstanceId, payload);
            if (!result.success || !Array.isArray(result.savedFields) || Object.keys(payload).some(key => !result.savedFields.includes(key))) throw new Error('save');
            const readback = await refresh();
            if (!readback) { setFeedback('Настройки приняты, но состояние канала проверить не удалось. Введённые данные оставлены. Обновите статус перед повторным сохранением.'); return; }
            setDraft(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !selectedFields.has(key))));
            setFeedback('Настройки приняты для выбранного бизнеса. Состояние канала обновлено. Нажмите «Проверить связь».');
        } catch (error) { setFeedback(errorText(error)); }
        finally { pending.current = false; setBusy(false); }
    };
    const test = async () => {
        if (!currentInstanceId || !configSelected || !canEdit || pending.current) return;
        pending.current = true; setBusy(true); setFeedback('');
        try {
            const result = await tests[configSelected](currentInstanceId);
            if (configSelected === 'email') {
                const smtpMessage = result.smtpVerified ? 'SMTP-подключение проверено.' : 'SMTP не проверен.';
                const imapMessage = !result.imapConfigured
                    ? 'IMAP не настроен: входящие письма не проверены.'
                    : result.imapVerified
                        ? result.imapMailboxVerified && result.imapPolling
                            ? 'IMAP-вход и доступ к INBOX проверены, опрос запущен.'
                            : `IMAP-вход проверен, но доступ к INBOX ещё не подтверждён: проверка опросом ожидается или завершилась ошибкой${result.imapPolling ? '' : '; опрос не запущен'}.`
                        : `IMAP-вход не подтверждён${result.imapPolling ? ', хотя опрос запущен' : ''}. Проверьте сервер, порт и учётные данные.`;
                setFeedback(`${smtpMessage} ${imapMessage} Фактический приём подтвердит только входящее тестовое письмо.`);
            } else {
                setFeedback(result.success ? 'Связь проверена. Проверьте приём реального сообщения в диалогах.' : errorText({ response: { data: { error: result.error } } }));
            }
            await refresh();
        } catch (error) { setFeedback(errorText(error)); }
        finally { pending.current = false; setBusy(false); }
    };
    const disconnect = async () => {
        if (!currentInstanceId || !configSelected || !canEdit || pending.current) return;
        if (!window.confirm(`Отключить ${configs[configSelected].title}? AVA перестанет получать и отправлять сообщения этого канала. История диалогов сохранится.`)) return;
        pending.current = true; setBusy(true); setFeedback('');
        try {
            const result = await disconnectChannel(currentInstanceId, configSelected);
            if (!result.success) throw new Error('disconnect');
            const readback = await refresh();
            if (!readback || readback[configSelected] || readback[`${configSelected}Configured`] || (configSelected === 'email' && readback.emailImapConfigured)) {
                setFeedback('Не удалось подтвердить отключение. Обновите статус перед следующим действием.'); return;
            }
            const selectedFields = new Set(configs[configSelected].fields.map(field => field.key));
            setDraft(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !selectedFields.has(key))));
            setFeedback('Канал отключён. История диалогов сохранена.');
        } catch (error) { setFeedback(errorText(error)); }
        finally { pending.current = false; setBusy(false); }
    };
    if (!currentInstanceId) return <div className="ava-channels-empty">Выберите бизнес, чтобы настроить каналы связи.</div>;
    const canManageInstagram = canEdit && role !== 'platform_admin';
    const configSelected: ConfigChannelKey | null = selected && ['telegram','email','vk','max'].includes(selected) ? selected as ConfigChannelKey : null;
    const selectedConfigured = configSelected ? configSelected === 'email'
        ? Boolean(status?.emailConfigured || status?.emailImapConfigured)
        : Boolean(status?.[`${configSelected}Configured`]) : false;
    const selectedVerified = configSelected ? Boolean(status?.[configSelected]) : false;
    const instagramConnected = status?.instagram === true && status.instagramState === 'connected' && status.instagramInboundConfirmed === true;
    const instagramDetails: Record<NonNullable<ChannelStatus['instagramState']>, string> = {
        disabled: 'Подключение временно недоступно',
        not_connected: 'Аккаунт не подключён',
        awaiting_inbound: 'Ждём новый входящий Direct',
        connected: 'Новый Direct сохранён в AVA',
        paused: 'Подключение приостановлено',
    };
    const cards = [
        { key: 'amocrm', name: 'amoCRM', icon: MessageCircle, connected: null, detail: 'Клиенты, сделки и задачи вашей CRM' },
        { key: 'avito', name: 'Авито', icon: MessageCircle, connected: null, detail: 'Обращения по объявлениям' },
        { key: 'bnovo', name: 'Bnovo', icon: Building2, connected: status?.bnovoConfigured ? Boolean(status?.bnovo) : null, detail: status?.bnovoExternalHotelId ? `Отель #${status.bnovoExternalHotelId} · ${status?.bnovoMaskedAccount || 'аккаунт активен'}` : status?.bnovoConfigured ? (status?.bnovo ? 'Подключён к Bnovo' : 'Настроен, ожидает проверки') : 'Бронирования, номера и тарифы' },
        { key: 'telephony', name: 'Телефония', icon: Phone, connected: null, detail: 'Номера, входящие и исходящие звонки' },
        { key: 'whatsapp', name: 'WhatsApp', icon: MessageCircle, connected: Boolean(status?.whatsapp), detail: status?.whatsapp ? 'Готов к сообщениям' : status?.whatsappConfigured ? 'Ожидает подключения телефона' : 'Не подключён' },
        { key: 'telegram', name: 'Telegram', icon: Send, connected: Boolean(status?.telegram), detail: status?.telegramBotUsername ? `@${status.telegramBotUsername}` : status?.telegramConfigured ? 'Настроен, ожидает проверки' : 'Бот' },
        { key: 'email', name: 'Почта', icon: Mail, connected: Boolean(status?.email), detail: `Отправка: ${status?.emailSmtpVerified ? 'SMTP проверен' : status?.emailConfigured ? 'SMTP не проверен' : 'не настроена'} · Приём: ${status?.emailReceiving ? 'IMAP-вход и INBOX проверены, опрос запущен' : status?.emailImapVerified ? status?.emailImapMailboxVerified ? 'INBOX проверен, опрос не запущен' : 'IMAP-вход подтверждён, INBOX не проверен или недоступен' : status?.emailImapConfigured ? 'IMAP-вход не подтверждён' : 'не настроен'}` },
        { key: 'vk', name: 'ВКонтакте', icon: MessageCircle, connected: Boolean(status?.vk), detail: status?.vkGroupName || (status?.vkConfigured ? 'Настроен, ожидает проверки' : 'Сообщения сообщества') },
        { key: 'max', name: 'MAX', icon: Zap, connected: Boolean(status?.max), detail: status?.maxBotName || (status?.maxConfigured ? 'Настроен, ожидает проверки' : 'Бот') },
        { key: 'instagram', name: 'Instagram', icon: Instagram, connected: instagramConnected, detail: status?.instagramState === 'connected' && !instagramConnected
            ? instagramDetails.awaiting_inbound : status?.instagramState ? instagramDetails[status.instagramState] : 'Откройте канал для проверки' },
    ] as const;
    return <main className="ava-channels">
        <header className="ava-channels-heading"><div><p className="ava-channels-kicker">СВЯЗЬ · {currentInstance?.name || 'ВАШ БИЗНЕС'}</p><h1>Каналы связи</h1><p>Подключите каналы, через которые клиенты общаются с вашим бизнесом. История сохраняется в AVA.</p></div>
            <button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={17} aria-hidden="true" />{loading ? 'Проверяем…' : 'Обновить статус'}</button></header>
        <div className="ava-channels-grid" aria-label="Подключаемые каналы">
            {cards.map(({ key, name, icon: Icon, connected, detail }) => <button key={key} type="button" disabled={busy} className={`ava-channel-card ${selected === key ? 'is-selected' : ''}`} onClick={() => choose(key)} aria-pressed={selected === key} aria-expanded={selected === key} aria-controls={selected === key ? 'ava-channel-panel' : undefined}><span className="ava-channel-icon"><Icon size={21} aria-hidden="true" /></span><strong>{name}</strong><span className={`ava-channel-state ${connected ? 'is-connected' : ''}`} style={(key==='telephony'||(key==='bnovo'&&!status?.bnovoConfigured))?{color:'var(--text-secondary)'}:undefined}>{key === 'telephony' ? <Phone size={14} aria-hidden="true" /> : connected ? <Check size={14} /> : <CircleAlert size={14} />}{key === 'amocrm' || key === 'avito' ? 'Открыть подключение' : key === 'telephony' ? 'Открыть номера' : key === 'bnovo' ? (status?.bnovoConfigured ? (connected ? 'Подключён' : 'Настроен, не проверен') : 'Открыть подключение') : !status ? 'Статус не получен' : key === 'email' ? connected ? 'SMTP и IMAP проверены' : status?.emailSmtpVerified || status?.emailImapVerified ? 'Частично проверена' : 'Не подключена' : key === 'instagram' ? connected ? 'Подключён' : status?.instagramState === 'awaiting_inbound' || status?.instagramState === 'connected' ? 'Ждём Direct' : status?.instagramState === 'paused' ? 'Приостановлен' : status?.instagramState === 'disabled' ? 'Недоступен' : status?.instagramState === 'not_connected' ? 'Не подключён' : 'Проверить состояние' : connected ? 'Подключён' : 'Не подключён'}</span><small>{!status && !['telephony','amocrm','avito','bnovo'].includes(key) ? 'Откройте канал или повторите проверку статуса' : detail}</small><ChevronRight className="ava-channel-arrow" size={17} aria-hidden="true" /></button>)}
        </div>
        {!status && <p className="ava-channel-status-loading" role="status">{loading || !statusUnavailable ? 'Проверяем подключение каналов…' : 'Состояние каналов недоступно. Нажмите «Обновить статус», чтобы повторить проверку.'}</p>}
        {configSelected && <section id="ava-channel-panel" className="ava-channel-config" aria-labelledby="ava-channel-config-title">
            <ol className="ava-channel-steps" aria-label="Этапы подключения канала">
                <li className="is-complete"><span>1</span><strong>Канал выбран</strong></li>
                <li className={selectedConfigured ? 'is-complete' : 'is-current'} aria-current={selectedConfigured ? undefined : 'step'}><span>2</span><strong>Сохраните настройки</strong></li>
                <li className={selectedVerified ? 'is-complete' : selectedConfigured ? 'is-current' : ''} aria-current={selectedConfigured && !selectedVerified ? 'step' : undefined}><span>3</span><strong>Проверьте связь</strong></li>
            </ol>
            <div><p className="ava-channels-kicker">НАСТРОЙКА КАНАЛА</p><h2 id="ava-channel-config-title">{configs[configSelected].title}</h2><p>{configs[configSelected].description}</p></div>
            {canEdit ? <form onSubmit={save} aria-busy={busy}><div className="ava-channel-fields">{configs[configSelected].fields.map(field => <label key={field.key}><span>{field.label}</span><input disabled={busy} maxLength={4096} value={draft[field.key] || ''} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value }))} type={field.secret ? 'password' : field.type || 'text'} autoComplete="off" placeholder={field.placeholder || (field.secret ? 'Оставьте пустым, чтобы не менять' : '')} /></label>)}</div><p className="ava-channel-hint">Токены не показываются повторно. Пустые поля не меняют сохранённые значения.</p><div className="ava-channel-actions"><button type="submit" className="ava-channel-primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить настройки'}</button><button type="button" onClick={() => void test()} disabled={busy || !selectedConfigured}>{busy ? 'Проверяем…' : 'Проверить связь'}</button>{selectedConfigured && <button type="button" className="ava-channel-disconnect" onClick={() => void disconnect()} disabled={busy}>Отключить канал</button>}</div></form>
                : <p className="ava-channel-hint">Изменять настройки может владелец бизнеса. Вы можете просматривать состояние каналов.</p>}</section>}
        {selected === 'whatsapp' && <WhatsAppConnectionPanel key={currentInstanceId} businessId={currentInstanceId} canManage={canEdit} sessionId={currentInstance?.openWaSessionId} businessName={currentInstance?.name || 'выбранному бизнесу'} />}
        {selected === 'instagram' && <div id="ava-channel-panel"><InstagramConnectionPanel key={currentInstanceId} businessId={currentInstanceId} canManage={canManageInstagram} /></div>}
        {(selected === 'amocrm' || selected === 'avito') && <ExternalIntegrationPanel key={`${currentInstanceId}:${selected}`} businessId={currentInstanceId} provider={selected} canManage={canEdit}/>}
        {selected === 'bnovo' && <BnovoIntegrationPanel key={currentInstanceId} businessId={currentInstanceId} canManage={canEdit} />}
        {selected === 'telephony' && <div className="space-y-6"><TelephonyPanel key={currentInstanceId} businessId={currentInstanceId} /><VoiceSettings key={`voice:${currentInstanceId}`} businessId={currentInstanceId} /></div>}
        {feedback && <p className="ava-channel-feedback" role="status">{feedback}</p>}
    </main>;
}

type WhatsAppState = 'checking' | 'notConfigured' | 'notAuthorized' | 'initializing' | 'authenticating' | 'qr_ready' | 'authorized' | 'ready' | 'disconnected' | 'failed' | 'blocked' | string;
const whatsappLabels: Record<string, string> = {
    checking: 'Проверяем подключение', notConfigured: 'Не подключён', notAuthorized: 'Ожидает привязки',
    starting: 'Запускаем подключение', initializing: 'Запускаем подключение', authenticating: 'Подтверждаем подключение', qr_ready: 'Ожидает сканирования QR',
    authorized: 'Подключён', ready: 'Подключён', disconnected: 'Отключён', failed: 'Требует внимания', blocked: 'Заблокирован',
};
const whatsappError = (error: unknown) => {
    const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
    if (code === 'WHATSAPP_ACCOUNT_CHANGED') return 'QR отсканирован другим аккаунтом. Отключите прежний номер, затем подключите новый. История CRM сохранится.';
    if (code === 'WHATSAPP_CONNECTION_CHANGED') return 'Подключение изменилось. Обновите статус и повторите действие.';
    return 'Не удалось подтвердить действие WhatsApp. Обновите статус и повторите попытку.';
};
function WhatsAppConnectionPanel({ businessId, canManage, sessionId, businessName }: { businessId: number; canManage: boolean; sessionId?: string; businessName: string }) {
    const { refreshInstances, currentInstance } = useInstance();
    const [state, setState] = useState<WhatsAppState>('checking');
    const [checked, setChecked] = useState(false);
    const [phone, setPhone] = useState('');
    const [qr, setQr] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const qrRequested = useRef(false);
    const alive = useRef(true);
    const applyStatus = useCallback((data: any) => {
        if (!data?.success || !data.state) throw new Error('status');
        const nextState = data.state.connectionErrorCode ? 'failed' : data.state.stateInstance || data.state.rawStatus || 'notConfigured';
        setState(nextState); setPhone(data.state.phone || ''); setChecked(true);
        if (data.state.connectionErrorCode) {
            setQr(''); setError(data.state.connectionErrorCode === 'WHATSAPP_ACCOUNT_CHANGED'
                ? 'Этот QR отсканирован другим аккаунтом. Отключите старый номер перед заменой.'
                : 'Подключение требует внимания. Обновите статус или обратитесь в поддержку AVA.');
        } else if (nextState === 'authorized' || nextState === 'ready') {
            setQr(''); qrRequested.current = false; setError('');
        } else if (nextState === 'failed') {
            setQr(''); setError('Не удалось запустить WhatsApp. Нажмите «Повторить подключение».');
        } else setError('');
        return nextState;
    }, []);
    const refresh = useCallback(async (force = true) => {
        try { const data = await getOpenWaStatus(businessId, force); if (alive.current) applyStatus(data); }
        catch { if (alive.current) { setChecked(false); setState('checking'); setError('Не удалось проверить подключение. Повторите проверку статуса.'); } }
    }, [businessId, applyStatus]);
    useEffect(() => {
        alive.current = true;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const data = await getOpenWaStatus(businessId);
                if (!alive.current) return;
                const nextState = applyStatus(data);
                if (qrRequested.current && canManage && nextState !== 'authorized' && nextState !== 'ready') {
                    const result = await getOpenWaQR(businessId);
                    if (!alive.current) return;
                    if (result.success && (result.type === 'qrCode' || result.type === 'qr')) {
                        const raw = String(result.message || result.qr || result.data?.qr || '').replace(/^data:image\/png;base64,/, '');
                        setQr(/^[a-zA-Z0-9+/=\r\n]+$/.test(raw) ? raw : '');
                    }
                }
            } catch { if (alive.current) { setChecked(false); setState('checking'); setError('Не удалось проверить подключение. Повторите проверку статуса.'); } }
            if (alive.current) timer = setTimeout(poll, 5000);
        };
        void poll();
        return () => { alive.current = false; clearTimeout(timer); };
    }, [businessId, canManage, applyStatus]);
    const connect = async () => {
        if (!canManage || busy || !checked) return;
        setBusy(true); setError(''); setNotice('');
        try {
            const current = await getOpenWaStatus(businessId, true);
            if (!alive.current) return;
            const verifiedState = applyStatus(current);
            if (verifiedState === 'authorized' || verifiedState === 'ready') {
                setNotice('Подключение проверено. WhatsApp готов к работе.');
                return;
            }
            // Retrying a failed startup or reopening its QR keeps the same account binding.
            // A new account is created only after a confirmed disconnection.
            qrRequested.current = true;
            const result = sessionId && verifiedState === 'disconnected'
                ? await replaceWhatsApp(businessId, sessionId) : await connectWhatsApp(businessId);
            if (!alive.current) return;
            if (!result.success) throw new Error('connect');
            const raw = String(result.message || result.qr || result.data?.qr || '').replace(/^data:image\/png;base64,/, '');
            if (result.type === 'qrCode' || result.type === 'qr') setQr(/^[a-zA-Z0-9+/=\r\n]+$/.test(raw) ? raw : '');
            if (result.type === 'pending') setNotice('Подключение запускается. QR появится автоматически.');
            if (result.type === 'alreadyLogged') { qrRequested.current = false; setQr(''); }
            await refreshInstances();
            await refresh(true);
        } catch (cause) { if (alive.current) { qrRequested.current = false; setQr(''); await refresh(true); setError(whatsappError(cause)); } }
        finally { if (alive.current) setBusy(false); }
    };
    const disconnect = async () => {
        if (!canManage || busy || !checked || !sessionId || !window.confirm('Отключить старый WhatsApp-номер? Приём и отправка остановятся. История клиентов и диалогов CRM сохранится.')) return;
        setBusy(true); setError(''); setNotice('Отключаем старый номер…');
        try {
            const result = await logoutOpenWa(businessId);
            if (!result.success) throw new Error('logout');
            const checkedResult = await getOpenWaStatus(businessId, true);
            if (!checkedResult.success || !checkedResult.state || (checkedResult.state.stateInstance || checkedResult.state.rawStatus) !== 'disconnected') throw new Error('unconfirmed');
            if (!alive.current) return;
            applyStatus(checkedResult); qrRequested.current = false; setQr(''); setPhone('');
            setNotice('Старый номер отключён и проверен. История сохранена. Теперь подключите новый номер по QR.');
            await refreshInstances();
        } catch { if (alive.current) { setChecked(false); setState('checking'); setNotice(''); setError('Не удалось подтвердить отключение. Обновите статус перед подключением нового номера.'); } }
        finally { if (alive.current) setBusy(false); }
    };
    const connected = state === 'authorized' || state === 'ready';
    return <section id="ava-channel-panel" className="ava-channel-config ava-whatsapp-panel" aria-labelledby="ava-channel-config-title" aria-busy={busy}>
        <div><p className="ava-channels-kicker">НАСТРОЙКА КАНАЛА</p><h2 id="ava-channel-config-title">WhatsApp</h2><p>Проверьте подключение, привяжите телефон по QR или замените номер.</p></div>
        <div className="ava-whatsapp-content">
            <ol className="ava-whatsapp-flow"><li>Проверьте текущий номер.</li><li>Для замены отключите старый и дождитесь подтверждения.</li><li>Подключите новый по QR. История CRM сохранится.</li></ol>
            <p role="status" className="ava-whatsapp-status">{checked ? whatsappLabels[state] || 'Проверяем подключение' : 'Проверяем подключение'}{checked && phone ? ` · +${phone.replace(/\D/g, '')}` : ''}</p>
            {error && <p role="alert" className="ava-whatsapp-error">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <div className="ava-channel-actions">
                <button type="button" onClick={() => void refresh(true)} disabled={busy}>Обновить статус</button>
                {canManage && <button type="button" className="ava-channel-primary" onClick={() => void connect()} disabled={busy || !checked}>{busy ? 'Подождите…' : connected ? 'Проверить WhatsApp' : sessionId && state === 'disconnected' ? 'Подключить новый номер' : sessionId ? state === 'failed' || state === 'blocked' ? 'Повторить подключение' : 'Показать QR' : 'Подключить WhatsApp'}</button>}
                {canManage && sessionId && checked && state !== 'disconnected' && <button type="button" className="ava-channel-disconnect" onClick={() => void disconnect()} disabled={busy}>Отключить старый номер</button>}
            </div>
            <WhatsAppResponseSettings key={businessId} businessId={businessId} canManage={canManage} typingAvailable={currentInstance?.whatsappProvider === 'openwa'}/>
            {!canManage && <p className="ava-channel-hint">Подключением управляет владелец бизнеса.</p>}
            {qr && canManage && <div className="ava-whatsapp-qr"><img src={`data:image/png;base64,${qr}`} alt={`QR для подключения WhatsApp к ${businessName}`} /><p>WhatsApp на телефоне → Связанные устройства → Привязка устройства.</p></div>}
        </div>
    </section>;
}
