import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { checkExternalSip, createExternalSip, disconnectExternalSip, getExternalSipRequest, getPhoneOperation, getTelephony,
    setPrimaryPhone, updateExternalSip, type ExternalSipInput, type ExternalSipTrunk, type Operation, type Telephony } from '../api/telephony';
import { formatCustomerPhone } from '../customerDisplay';

type Pending = { key: string; kind: 'create'|'edit'|'check'|'disconnect' };
type Form = Omit<ExternalSipInput, 'port'> & { port: string };
const blank = (): Form => ({ number: '', host: '', port: '5060', transport: 'udp', login: '', password: '' });
const states: Record<string, string> = { active: 'Подключён', provisioning: 'Подключается', manual: 'Нужна проверка',
    suspended: 'Приостановлен', grace: 'Отключается', releasing: 'Отключается', released: 'Отключён' };
function failure(error: unknown) {
    const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
    const known: Record<string, string> = {
        TELEPHONY_SIP_PASSWORD_INVALID: 'В пароле SIP есть неподдерживаемые символы. Уточните данные подключения у оператора.',
        TELEPHONY_SIP_LOGIN_INVALID: 'Проверьте логин SIP, выданный оператором.',
        TELEPHONY_SIP_HOST_INVALID: 'Укажите адрес SIP-сервера вашего оператора без пути и протокола.',
        TELEPHONY_SIP_HOST_PRIVATE: 'Укажите публичный адрес SIP-сервера вашего оператора.',
        TELEPHONY_SIP_TRANSPORT_INVALID: 'Проверьте порт и способ подключения.',
        TELEPHONY_SIP_TRANSPORT_UNAVAILABLE: 'Этот способ подключения сейчас недоступен.',
        TELEPHONY_SIP_REVISION_CHANGED: 'Подключение изменилось. Обновите список перед сохранением.',
        TELEPHONY_SIP_OPERATION_PENDING: 'Предыдущее изменение ещё выполняется. Обновите список.',
        TELEPHONY_EXTERNAL_HOST_NOT_READY: 'Подключение своего оператора сейчас недоступно. Повторите проверку позже.',
        TELEPHONY_RATE_LIMIT: 'Слишком много изменений подряд. Попробуйте через минуту.',
        TELEPHONY_NUMBER_LIMIT: 'Достигнут лимит подключённых номеров.',
        TELEPHONY_EXTERNAL_SIP_INVALID: 'Проверьте номер, адрес сервера и данные входа.',
        TELEPHONY_INPUT_INVALID: 'Проверьте номер, адрес сервера и данные входа.',
        TELEPHONY_EXTERNAL_SIP_REVISION_CONFLICT: 'Подключение уже изменилось. Обновите список перед сохранением.',
        TELEPHONY_EXTERNAL_SIP_HOST_INVALID: 'Укажите публичный адрес SIP-сервера вашего оператора.',
        TELEPHONY_EXTERNAL_SIP_TRANSPORT_UNAVAILABLE: 'Этот способ подключения недоступен. Выберите другой из списка.',
        TELEPHONY_NUMBER_ALREADY_BOUND: 'Этот номер уже подключён. Обновите список номеров.',
        TELEPHONY_CALLS_DRAINING: 'Изменение будет применено после завершения звонков.',
        TELEPHONY_OWNER_REQUIRED: 'Изменять телефонию может владелец бизнеса.',
    };
    return known[code || ''] || 'Не удалось подтвердить изменение. Проверьте результат перед повторной попыткой.';
}
type Props = { businessId: number; data: Telephony; onChanged: () => void };
export default function ExternalSipSettings(props: Props) {
    if (!props.data.externalSip && !props.data.externalTrunks?.length) return null;
    return <ScopedSipSettings {...props} />;
}
function ScopedSipSettings({ businessId, data, onChanged }: Props) {
    const auth = useAuth();
    return <SipPanel key={`${businessId}:${auth.userId || auth.loginName || 'session'}:${data.canManage}`} businessId={businessId}
        data={data} onChanged={onChanged} storageKey={`ava:sip-request:${auth.userId || auth.loginName || 'session'}:${businessId}`} />;
}
function SipPanel({ businessId, data, onChanged, storageKey }: { businessId: number; data: Telephony; onChanged: () => void; storageKey: string }) {
    const id = useId(), alive = useRef(true), lock = useRef(false), request = useRef<AbortController | null>(null);
    const [form, setForm] = useState<Form | null>(null), [editing, setEditing] = useState<ExternalSipTrunk | null>(null);
    const [baseline, setBaseline] = useState<Form | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [pending, setPending] = useState<Pending | null>(() => {
        try { const p = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
            return p && /^[a-f0-9-]{36}$/.test(p.key) && ['create','edit','check','disconnect'].includes(p.kind) ? p : null;
        } catch { return null; }
    });
    const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
    useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
    const trunks = data.externalTrunks || [], canEdit = data.canManage && data.externalSip?.available === true;
    const stale = Boolean(editing && trunks.find(t => t.id === editing.id)?.revision !== editing.revision);
    function remember(value: Pending | null) {
        setPending(value);
        // Only a request key is retained. SIP passwords and login are never stored in browser storage.
        try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory recovery remains available. */ }
    }
    function begin(trunk?: ExternalSipTrunk) {
        setError(''); setNotice(''); setEditing(trunk || null);
        const value = trunk ? { number: trunk.number, host: trunk.host, port: String(trunk.port), transport: trunk.transport, login: '', password: '' }
            : { ...blank(), transport: data.externalSip?.transports[0] || 'udp' };
        setForm(value); setBaseline(value);
    }
    function accepted(op: Operation) {
        if (!op || typeof op.id !== 'string' || !op.id || typeof op.state !== 'string') throw Error('invalid_operation');
        if (op.state === 'failed' || op.state === 'manual') setError(failure({ response: { data: { code: op.errorCode } } }));
        else setNotice(op.state === 'done' ? 'Состояние подключения обновлено.' : 'Запрос принят. Состояние подключения обновится здесь.');
        remember(null); setConfirmDisconnect(null); onChanged();
    }
    async function recover() {
        if (!pending || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        const c = new AbortController(); request.current = c;
        try {
            const result = await getExternalSipRequest(businessId, pending.key, c.signal);
            if (!result.success || result.businessId !== businessId) throw Error('invalid_scope');
            if (!alive.current || c.signal.aborted) return;
            if (result.operation) { accepted(result.operation); setForm(null); setEditing(null); }
            else { remember(null); setNotice('Изменение не найдено. Можно повторить сохранение.'); onChanged(); }
        } catch (e) { if (alive.current) setError(failure(e)); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    }
    async function run(kind: Pending['kind'], action: (key: string, signal: AbortSignal) => Promise<Operation>) {
        if (!canEdit || pending || lock.current) return;
        const key = crypto.randomUUID(), c = new AbortController(); request.current = c;
        lock.current = true; setBusy(true); setError(''); setNotice(''); remember({ key, kind });
        try {
            const operation = await action(key, c.signal);
            if (!operation || typeof operation.id !== 'string') throw Error('invalid_operation');
            const readback = await getPhoneOperation(businessId, operation.id, c.signal);
            if (readback.id !== operation.id) throw Error('readback');
            if (!alive.current || c.signal.aborted) return;
            accepted(readback); setForm(null); setEditing(null);
        } catch (e) { if (alive.current) setError(failure(e)); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    }
    function save(event: FormEvent) {
        event.preventDefault(); if (!form || stale) return;
        const values = { ...form, port: Number(form.port) };
        if (!editing) void run('create', (key, signal) => createExternalSip(businessId, values, key, signal));
        else {
            const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => ['login','password'].includes(key)
                ? Boolean(value) : String(value) !== String(baseline?.[key as keyof Form])));
            if (!Object.keys(patch).length) { setNotice('Изменений нет.'); return; }
            void run('edit', (key, signal) => updateExternalSip(businessId, editing.id, { ...patch, expectedRevision: editing.revision }, key, signal));
        }
    }
    async function primary(trunk: ExternalSipTrunk) {
        if (!canEdit || pending || lock.current) return;
        lock.current = true; setBusy(true); setError(''); setNotice('');
        const c = new AbortController(); request.current = c;
        try {
            await setPrimaryPhone(businessId, trunk.id, c.signal);
            const current = await getTelephony(businessId, c.signal);
            if (!current.success || !current.numbers.some(row => row.id === trunk.id && row.isPrimary)) throw Error('unconfirmed');
            if (alive.current && !c.signal.aborted) { setNotice('Номер выбран для исходящих звонков.'); onChanged(); }
        } catch (e) { if (alive.current) setError(failure(e)); }
        finally { lock.current = false; if (alive.current) setBusy(false); }
    }
    if (!data.externalSip && !trunks.length) return null;
    return <section id="external-sip-settings" className="ava-external-sip" aria-labelledby={`${id}-title`} aria-busy={busy}>
        <h3 id={`${id}-title`}>Своя телефония</h3>
        {trunks.map(trunk => <article className="ava-telephony-manual" key={trunk.id}>
            <h4>{formatCustomerPhone(trunk.number) || trunk.number}</h4>
            <p>{trunk.registration === 'registered' ? 'Связь с оператором установлена' : trunk.registration === 'unregistered' ? 'Нет связи с оператором' : trunk.state === 'active' ? 'Связь с оператором проверяется' : states[trunk.state] || 'Связь с оператором проверяется'}</p>
            <p className="ava-channel-hint">{trunk.host || 'Адрес недоступен'}{trunk.port ? `:${trunk.port}` : ''} · {trunk.transport?.toUpperCase() || 'Проверяется'}</p>
            {trunk.lastErrorCode && <p role="alert">{failure({ response: { data: { code: trunk.lastErrorCode } } })}</p>}
            {data.numbers.some(phone => phone.id === trunk.id && phone.isPrimary) && <p>Основной номер для исходящих</p>}
            {canEdit && <div className="ava-channel-actions">
                <button type="button" disabled={busy || Boolean(pending) || !trunk.host || !trunk.port || !trunk.transport} onClick={() => begin(trunk)}>Изменить подключение</button>
                <button type="button" disabled={busy || Boolean(pending)} onClick={() => void run('check', (key, signal) => checkExternalSip(businessId, trunk.id, trunk.revision, key, signal))}>Проверить связь</button>
                {trunk.state === 'active' && !data.numbers.some(phone => phone.id === trunk.id && phone.isPrimary) && <button type="button" disabled={busy || Boolean(pending)} onClick={() => void primary(trunk)}>Использовать для исходящих</button>}
                <button type="button" disabled={busy || Boolean(pending)} onClick={() => setConfirmDisconnect(trunk.id)}>Отключить</button>
            </div>}
            {confirmDisconnect === trunk.id && <div role="region" aria-label="Подтверждение отключения">
                <p>Отключить этот номер от AVA? Номер останется у вашего оператора.</p>
                <button type="button" disabled={busy} onClick={() => void run('disconnect', (key, signal) => disconnectExternalSip(businessId, trunk.id, trunk.revision, key, signal))}>Подтвердить отключение</button>
                <button type="button" disabled={busy} onClick={() => setConfirmDisconnect(null)}>Отмена</button>
            </div>}
        </article>)}
        {error && <p role="alert" className="ava-channel-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {pending && <div className="ava-channel-actions"><p>Проверьте результат перед следующим изменением.</p><button type="button" disabled={busy} onClick={() => void recover()}>{busy ? 'Проверяем…' : 'Проверить результат'}</button></div>}
        {!form && canEdit && !pending && <button type="button" disabled={busy} className="ava-channel-primary" onClick={() => begin()}>Подключить своего оператора</button>}
        {data.canManage && !data.externalSip?.available && !pending && <p>Подключение своего оператора сейчас недоступно. <button type="button" disabled={busy} onClick={onChanged}>Повторить проверку</button></p>}
        {form && <form className="ava-external-sip-form" onSubmit={save}>
            <h4>{editing ? 'Настройки подключения' : 'Подключите номер вашего оператора'}</h4>
            <fieldset disabled={!canEdit || busy || Boolean(pending)}>
                {(['number','host','port','login','password'] as const).map(key => <label key={key} htmlFor={`${id}-${key}`}>
                    {{ number: 'Номер компании', host: 'SIP-сервер', port: 'Порт', login: 'Логин SIP', password: 'Пароль SIP' }[key]}
                    <input id={`${id}-${key}`} type={key === 'password' ? 'password' : key === 'port' ? 'number' : key === 'number' ? 'tel' : 'text'}
                        required={!editing || !['login','password'].includes(key)} min={key === 'port' ? 1 : undefined} max={key === 'port' ? 65535 : undefined}
                        maxLength={key === 'password' ? 256 : 255} autoComplete={key === 'password' ? 'new-password' : 'off'} value={form[key]}
                        placeholder={editing && ['login','password'].includes(key) ? 'Оставьте пустым, чтобы сохранить' : key === 'number' ? '+7…' : key === 'host' ? 'sip.example.ru' : undefined}
                        onChange={event => setForm(current => current ? { ...current, [key]: event.target.value } : current)} />
                </label>)}
                <label htmlFor={`${id}-transport`}>Подключение<select id={`${id}-transport`} value={form.transport} onChange={event => setForm(current => current ? { ...current, transport: event.target.value as Form['transport'] } : current)}>
                    {data.externalSip?.transports.map(transport => <option key={transport} value={transport}>{transport.toUpperCase()}{transport === 'tls' ? ' — защищённое соединение' : ''}</option>)}
                </select></label>
                <p>Данные подключения выдаёт ваш оператор телефонии. Номер не приобретается повторно.</p>
                {stale && <p role="alert">Подключение изменилось. Закройте форму и откройте её заново, чтобы увидеть текущие настройки.</p>}
                <button type="submit" disabled={stale} className="ava-channel-primary">{editing ? 'Сохранить подключение' : 'Подключить'}</button>
            </fieldset>
            <button type="button" disabled={busy} onClick={() => { setForm(null); setEditing(null); setError(''); }}>Отмена</button>
        </form>}
    </section>;
}
