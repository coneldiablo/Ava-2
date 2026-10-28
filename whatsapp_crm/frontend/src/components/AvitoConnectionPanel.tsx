import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {CheckCircle2, ChevronRight, MessageCircle} from 'lucide-react';
import {api} from '../api';

type Connection = {
    provider: 'avito'; status: string; configured: boolean;
    account: {name: string} | null; config?: {clientId?: string};
    lastSuccessAt: string | null;
    exchange?: {historyRestrictedChats?: number};
    error: {code: string; message: string; action: string} | null;
};
const errors: Record<string,string> = {
    EXTERNAL_CREDENTIALS_REQUIRED: 'Укажите ID и секрет приложения Авито.',
    EXTERNAL_CREDENTIAL_INVALID: 'Проверьте ID и секрет приложения Авито.',
    EXTERNAL_AUTH_REQUIRED: 'Авито отклонил авторизацию. Проверьте данные в настройках подключения.',
    EXTERNAL_ACCESS_DENIED: 'У приложения нет доступа к сообщениям Авито. Проверьте разрешения в кабинете Авито.',
    EXTERNAL_RATE_LIMITED: 'Авито временно ограничил запросы. AVA продолжит обмен после паузы.',
    EXTERNAL_TIMEOUT: 'Авито не ответил вовремя. Повторите подключение через несколько минут.',
    EXTERNAL_AUTH_IN_PROGRESS: 'Подключение уже выполняется. Подождите несколько секунд и повторите попытку.',
    EXTERNAL_OUTCOME_UNKNOWN: 'Отправка ещё не подтверждена. Проверьте сообщение в Авито перед повторной отправкой.',
    EXTERNAL_ACCOUNT_ALREADY_CONNECTED: 'Этот аккаунт Авито подключён к другому бизнесу.',
    EXTERNAL_CONNECTION_CHANGED: 'Настройки подключения изменились. Обновите страницу и повторите подключение.',
    AVITO_CHAT_SUBSCRIPTION_REQUIRED: 'Для этого диалога Авито требует подписку с API мессенджера.',
};
function readableError(error: unknown) {
    const code = (error as {response?: {data?: {code?: string}}})?.response?.data?.code;
    return code && errors[code] || 'Не удалось подключить Авито. Повторите попытку через несколько минут.';
}

export default function AvitoConnectionPanel({businessId, canManage}: {businessId:number; canManage:boolean}) {
    const [connection,setConnection] = useState<Connection|null>(null);
    const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false);
    const [loadAttempt,setLoadAttempt] = useState(0);
    const [error,setError] = useState(''), [clientId,setClientId] = useState(''), [secret,setSecret] = useState('');
    const life = useRef<AbortController|null>(null), lock = useRef(false);
    const base = `/external-integrations/${businessId}/avito`;
    const connected = connection?.status === 'connected';
    const configured = connection?.configured && connection.status !== 'disconnected';
    function apply(value: Connection) {
        if(value?.provider !== 'avito' || typeof value.configured !== 'boolean') throw Error('INVALID_STATUS');
        setConnection(value); setClientId(value.config?.clientId || '');
    }
    useEffect(() => {
        const controller = new AbortController(); life.current = controller;
        async function load() {
            try {
                const {data} = await api.get(base,{signal:controller.signal,timeout:20000});
                if(controller.signal.aborted) return;
                if(!data.success) throw Error('INVALID_STATUS');
                apply(data.integration); setError('');
            } catch {
                if(!controller.signal.aborted) setError('Не удалось загрузить состояние Авито. Обновите страницу.');
            } finally { if(!controller.signal.aborted) setLoading(false); }
        }
        void load();
        return () => controller.abort();
    }, [base,loadAttempt]);
    async function connect(event?: FormEvent, updateCredentials = false) {
        event?.preventDefault();
        if(!canManage || lock.current || !connection) return;
        const signal = life.current!.signal;
        lock.current = true; setBusy(true); setError('');
        try {
            const body = updateCredentials || !configured ? {clientId:clientId.trim(),...(secret ? {clientSecret:secret} : {})} : {};
            const {data} = await api.post(base+'/connect',body,{signal,timeout:60000});
            if(signal.aborted) return;
            if(!data.success) throw Error('CONNECT_FAILED');
            apply(data.integration); setSecret('');
        } catch(cause) {
            if(!signal.aborted) {
                setError(readableError(cause));
                // A failed subscription can follow a successful credential
                // save; read the current state instead of retaining an old badge.
                try { const {data} = await api.get(base,{signal,timeout:20000});
                    if(!signal.aborted && data.success) apply(data.integration);
                } catch { /* Keep the actionable error from the attempted setup. */ }
            }
        }
        finally { lock.current = false; if(!signal.aborted) setBusy(false); }
    }
    async function disconnect() {
        if(!canManage || lock.current || !window.confirm('Отключить Авито? Сообщения перестанут поступать в AVA. История сохранится.')) return;
        const signal = life.current!.signal; lock.current = true; setBusy(true); setError('');
        try {
            const {data} = await api.delete(base,{signal,timeout:20000});
            if(signal.aborted) return;
            if(!data.success || data.integration?.status !== 'disconnected') throw Error('DISCONNECT_FAILED');
            apply(data.integration); setSecret('');
        } catch { if(!signal.aborted) setError('Не удалось отключить Авито. Обновите страницу и повторите попытку.'); }
        finally { lock.current = false; if(!signal.aborted) setBusy(false); }
    }
    const form = <form className="ava-avito-form" onSubmit={event=>void connect(event,true)}>
        <fieldset disabled={busy} className="ava-channel-fields">
            <label><span>ID приложения</span><input name="avito-client-id" value={clientId} required autoComplete="off" onChange={e=>setClientId(e.target.value)}/></label>
            <label><span>Секрет приложения</span><input name="avito-client-secret" type="password" value={secret} required={!configured} autoComplete="new-password" placeholder={configured ? 'Сохранён' : undefined} onChange={e=>setSecret(e.target.value)}/></label>
        </fieldset>
        <div className="ava-channel-actions"><button type="submit" className="ava-channel-primary" disabled={busy}>
            {busy ? 'Подключаем…' : connected ? 'Обновить подключение' : 'Подключить Авито'}
        </button></div>
    </form>;
    return <section id="ava-channel-panel" className="ava-channel-config ava-avito-panel" aria-labelledby="avito-title">
        <div><p className="ava-channels-kicker">КАНАЛ СООБЩЕНИЙ</p><h2 id="avito-title">Авито</h2><p>Обращения с объявлений и ответы AVA — в общих диалогах.</p></div>
        <div className="ava-avito-content" aria-busy={loading || busy}>
            <div role="status" aria-live="polite">
                {loading ? 'Загружаем подключение…' : connection && <div className="ava-avito-status">
                    {connected ? <CheckCircle2 size={22} aria-hidden="true"/> : <MessageCircle size={22} aria-hidden="true"/>}
                    <div><strong>{connected ? 'Подключено' : configured ? 'Нужно восстановить подключение' : 'Не подключено'}</strong>
                    {connection.account?.name && <p>{connection.account.name}</p>}</div>
                </div>}
            </div>
            {connected && <><p className="ava-avito-description">Новые сообщения поступают автоматически. AVA отвечает по настройкам бизнеса.</p>
                <Link className="ava-avito-dialogues" to="/today?channel=avito">Открыть диалоги Авито <ChevronRight size={18} aria-hidden="true"/></Link></>}
            {(error || connection?.error) && <p className="ava-whatsapp-error" role="alert">{error || (connection?.error && (errors[connection.error.code] || `${connection.error.message} ${connection.error.action}`))}</p>}
            {!!connection?.exchange?.historyRestrictedChats && <p className="ava-channel-hint">Авито ограничил доступ к части диалогов. Для них нужна подписка с API мессенджера в Авито.</p>}
            {!loading && connection && canManage && <>
                {!configured ? form : <>
                    {!connected && <div className="ava-channel-actions"><button type="button" className="ava-channel-primary" disabled={busy} onClick={()=>void connect()}>{busy ? 'Подключаем…' : 'Восстановить подключение'}</button></div>}
                    <details className="ava-avito-settings"><summary>Настройки подключения</summary>
                        {form}<button type="button" className="ava-avito-disconnect" disabled={busy} onClick={()=>void disconnect()}>Отключить Авито</button>
                    </details>
                </>}
            </>}
            {!loading && connection && !canManage && <p className="ava-channel-hint">Подключением управляет владелец бизнеса.</p>}
            {!loading && !connection && <div className="ava-channel-actions"><button type="button" onClick={()=>{setLoading(true);setLoadAttempt(n=>n+1);}}>Повторить загрузку</button></div>}
        </div>
    </section>;
}
