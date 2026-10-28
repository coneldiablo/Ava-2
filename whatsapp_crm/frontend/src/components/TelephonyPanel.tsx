import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone as PhoneIcon, RefreshCw } from 'lucide-react';
import { buyPhone, findPhones, getPhoneCatalog, getPhoneOperation, getTelephony, releasePhone, setPrimaryPhone, getExistingPhones, importExistingPhone, getExistingPhoneOperation, getManualPhones,
    type Catalog, type Operation, type Quote, type Telephony, type ExistingCandidate, type ExistingMode, type ExistingImport, type ManualPhones } from '../api/telephony';
import './TelephonyPanel.css';
import ExternalSipSettings from './ExternalSipSettings';

const money=(value:number)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2}).format(value/100);
const labels:Record<string,string>={active:'Подключён',provisioning:'Подключается',manual:'Требует проверки',
    grace:'Ожидает освобождения',releasing:'Освобождается',released:'Освобождён',suspended:'Приостановлен'};
const stages:Record<string,string>={import_validate:'Проверяем принадлежность номера и входящий маршрут',import_apply:'Подключаем существующий SIP к AVA',import_verifying:'Проверяем существующее подключение',detach_check:'Ожидаем завершения звонков перед снятием привязки',validate:'Проверяем выбранный номер',locking:'Резервируем номер',locked:'Номер зарезервирован',
    buy_dispatching:'Проверяем результат покупки',buy_confirm:'Подтверждаем покупку',sip_pending:'Подключаем исходящие',
    sip_dispatching:'Проверяем создание исходящего подключения',sip_confirm:'Проверяем настройки оператора',host_apply:'Настраиваем звонки',
    host_verify:'Ожидаем подключения к оператору',forwarding:'Настраиваем входящие',forwarding_verify:'Проверяем входящий маршрут',
    active:'Номер подключён',release_check:'Ожидаем завершения звонков',compensate:'Возвращаем ресурсы оператору',
    delete_sip_dispatching:'Проверяем отключение исходящих',delete_sip_confirm:'Отключаем номер',delete_number_dispatching:'Проверяем отключение номера',
    delete_number_confirm:'Подтверждаем освобождение',failed:'Подключение не завершено',released:'Номер освобождён'};
function telephonyError(error:unknown) {
    const code=(error as {response?:{data?:{code?:string}}})?.response?.data?.code || (error as {code?:string})?.code;
    const text:Record<string,string>={TELEPHONY_PILOT_DISABLED:'Покупка номеров пока доступна участникам пилота. Обратитесь в поддержку AVA.',
        TELEPHONY_NUMBER_LIMIT:'Достигнут лимит: три номера, включая подключения в обработке и ожидающие освобождения.',
        TELEPHONY_QUOTE_EXPIRED:'Предложение истекло. Найдите доступные номера заново.',
        TELEPHONY_PRICE_CHANGED:'Стоимость изменилась. Найдите номера заново и подтвердите новую цену.',
        TELEPHONY_BALANCE_LOW:'Подключение ожидает пополнения баланса платформой AVA. Обратитесь в поддержку.',
        TELEPHONY_BALANCE_PENDING:'Проверка баланса ещё выполняется. Обновите состояние через минуту.',
        TELEPHONY_NUMBER_NO_LONGER_FREE:'Этот номер уже занят. Выберите другой из новых предложений.',
        TELEPHONY_INGRESS_NOT_READY:'Подключение телефонии ещё проверяется платформой AVA.',
        TELEPHONY_RELEASE_IN_PROGRESS:'Оператор уже обрабатывает освобождение номера. Отменить его сейчас нельзя.',
        TELEPHONY_PROVIDER_AUTH:'Доступ к оператору требует проверки поддержкой AVA.',
        TELEPHONY_RATE_LIMIT:'Слишком много запросов. Подождите минуту и повторите.',
        TELEPHONY_WAITING:'Проверка ещё выполняется. Обновите состояние через минуту.',
        TELEPHONY_OWNER_REQUIRED:'Управлять номерами может владелец бизнеса.',
        TELEPHONY_PRICE_LIMIT:'Стоимость превышает лимит пилота. Выберите другое предложение.',
        TELEPHONY_DIRECTIONS_UNAVAILABLE:'Выбранный номер не поддерживает нужные направления звонков.',
        TELEPHONY_OPERATION_FAILED:'Операция не завершена. Обратитесь в поддержку AVA.',
        TELEPHONY_CATALOG_INVALID:'Каталог номеров сейчас недоступен. Попробуйте загрузить его позже.',
        TELEPHONY_IMPORT_FORWARDING_REQUIRED:'Переадресация входящих звонков на AVA не подтверждена. Подключение заблокировано: поддержка должна проверить настройки и ограничения аккаунта у оператора.',
        TELEPHONY_IMPORT_SIP_REQUIRED:'У номера нет подходящего SIP-подключения для исходящих звонков. Если доступен режим «Только входящие», выберите его; исходящие останутся недоступны.',
        TELEPHONY_IMPORT_NOT_GRANTED:'Поддержка AVA ещё не разрешила привязку этого номера к вашему бизнесу.',
        TELEPHONY_IMPORT_IN_USE:'Номер используется в текущем звонке. Дождитесь завершения разговоров и повторите проверку.',
        TELEPHONY_IMPORT_SIP_SCOPE_INVALID:'Принадлежность SIP-подключения не подтверждена. Подключение заблокировано; обратитесь в поддержку AVA.',
        TELEPHONY_IMPORT_SIP_IN_USE:'Исходящее подключение уже занято. Поддержка должна проверить его принадлежность.',
        TELEPHONY_IMPORT_NUMBER_UNAVAILABLE:'Номер недоступен для входящих звонков в этом аккаунте оператора.',
        TELEPHONY_NUMBER_ALREADY_BOUND:'Номер уже привязан. Обновите состояние или обратитесь в поддержку AVA.',
        TELEPHONY_SIP_REGISTERING:'Исходящее подключение ещё не зарегистрировано у оператора. Ожидаем подтверждения.',
        TELEPHONY_PROVIDER_ERROR:'Оператор отклонил запрос. Поддержка AVA должна проверить ограничения аккаунта; номер не считается подключённым.'};
    if(code?.startsWith('TELEPHONY_EXISTING_'))return 'Не удалось привязать существующий номер. Поддержка AVA должна проверить принадлежность номера, маршрутизацию и доступность подключения.';
    return code && text[code] ? text[code] : 'Не удалось подтвердить действие. Обновите состояние или обратитесь в поддержку AVA.';
}
type PendingPurchase = { quote: Quote; key: string };
const pendingStorageKey = (businessId: number) => `ava-telephony-purchase:${businessId}`;
function readPending(businessId: number): PendingPurchase | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(pendingStorageKey(businessId)) || 'null');
        return value && typeof value.key === 'string' && typeof value.quote?.id === 'string'
            && typeof value.quote.number === 'string' && Number.isSafeInteger(value.quote.installKopecks)
            && Number.isSafeInteger(value.quote.monthlyKopecks) && Number.isFinite(value.quote.expiresAt) ? value : null;
    } catch { return null; }
}
function persistPending(businessId: number, value: PendingPurchase | null) {
    try {
        if (value) sessionStorage.setItem(pendingStorageKey(businessId), JSON.stringify(value));
        else sessionStorage.removeItem(pendingStorageKey(businessId));
    } catch { /* In-memory idempotency still protects retries when storage is unavailable. */ }
}
type PendingImport = { input: ExistingImport; key: string };
const importStorageKey=(businessId:number)=>`ava-telephony-import:${businessId}`;
function readImport(businessId:number):PendingImport|null {
    try {
        const value=JSON.parse(sessionStorage.getItem(importStorageKey(businessId)) || 'null');
        return value && typeof value.key==='string' && /^7\d{10}$/.test(value.input?.number)
            && ['sip','inbound_only'].includes(value.input.mode) && value.input.confirmUnused===true?value:null;
    }catch{return null;}
}
function persistImport(businessId:number,value:PendingImport|null) {
    try {
        if(value)sessionStorage.setItem(importStorageKey(businessId),JSON.stringify(value));
        else sessionStorage.removeItem(importStorageKey(businessId));
    }catch{ /* Same mounted session still keeps the original import key. */ }
}
function ManualPhoneSummary({businessId,canManage}:{businessId:number;canManage:boolean}) {
    const [phones,setPhones]=useState<ManualPhones|null>(null),[failed,setFailed]=useState(false);
    useEffect(()=>{
        const controller=new AbortController();
        void getManualPhones(businessId,controller.signal).then(value=>{if(!controller.signal.aborted)setPhones(value);})
            .catch(()=>{if(!controller.signal.aborted)setFailed(true);});
        return ()=>controller.abort();
    },[businessId]);
    if(failed)return <p className="ava-channel-hint">Не удалось проверить ручные номера. Существующие настройки сохранены; проверьте их в настройках бизнеса.</p>;
    if(!phones)return <p role="status" className="ava-channel-hint">Проверяем ручное подключение…</p>;
    if(!phones.inboundNumbers.length && !phones.outboundNumber)return null;
    return <div className="ava-telephony-manual" aria-label="Ручное подключение">
        <h3>Ручное подключение</h3>
        {phones.inboundNumbers.length>0 && <p>Входящие номера: {phones.inboundNumbers.join(', ')}</p>}
        {phones.outboundNumber && <p>Номер для исходящих: {phones.outboundNumber}</p>}
        <p className="ava-channel-hint">Это сохранённые настройки. Связь с оператором и звук подтвердит тестовый звонок.</p>
        {canManage && <a href="#external-sip-settings">Настроить своего оператора</a>}
    </div>;
}
export default function TelephonyPanel({businessId}:{businessId:number}) {
    return <ScopedTelephonyPanel key={businessId} businessId={businessId} />;
}
function ScopedTelephonyPanel({businessId}:{businessId:number}) {
    const [data,setData]=useState<Telephony|null>(null),[catalog,setCatalog]=useState<Catalog|null>(null);
    const [quotes,setQuotes]=useState<Quote[]>([]),[selected,setSelected]=useState<Quote|null>(null);
    const [typeId,setType]=useState(0),[regionId,setRegion]=useState(0),[busy,setBusy]=useState(false);
    const [message,setMessage]=useState(''),[error,setError]=useState(''),[searching,setSearching]=useState(false);
    const [loadError,setLoadError]=useState('');
    const [loading,setLoading]=useState(true),[pending,setPending]=useState<PendingPurchase|null>(()=>readPending(businessId));
    const [clock,setClock]=useState(Date.now());
    const [existing,setExisting]=useState<ExistingCandidate[]|null>(null),[existingUpdated,setExistingUpdated]=useState<number|null>(null);
    const [importNumber,setImportNumber]=useState(''),[importMode,setImportMode]=useState<ExistingMode>('sip'),[confirmUnused,setConfirmUnused]=useState(false);
    const [pendingImport,setPendingImport]=useState<PendingImport|null>(()=>readImport(businessId));
    const existingSelect=useRef<HTMLSelectElement>(null),importRetry=useRef<HTMLButtonElement>(null);
    useEffect(()=>{if(existing)existingSelect.current?.focus();},[existing]);
    useEffect(()=>{if(pendingImport && !busy)importRetry.current?.focus();},[pendingImport,busy]);
    const scope=useRef<AbortController|null>(null),actionLock=useRef(false),refreshRevision=useRef(0);
    const keys=useRef(new Map<string,string>());
    const typeSelect=useRef<HTMLSelectElement>(null),retryButton=useRef<HTMLButtonElement>(null),feedback=useRef<HTMLParagraphElement>(null);
    useEffect(()=>{if(catalog)typeSelect.current?.focus();},[catalog]);
    useEffect(()=>{if(pending && !busy)retryButton.current?.focus();},[pending,busy]);
    useEffect(()=>{if(message.startsWith('Заказ принят.') || message.startsWith('Заявка на привязку принята.'))feedback.current?.focus();},[message]);
    const refresh=useCallback(async(signal:AbortSignal)=>{
        const revision=++refreshRevision.current;
        try {
            const next=await getTelephony(businessId,signal);
            if(!signal.aborted && revision===refreshRevision.current){setData(next);setLoadError('');}
        } catch(e) {if(!signal.aborted && revision===refreshRevision.current)setLoadError(telephonyError(e));}
        finally {if(!signal.aborted && revision===refreshRevision.current)setLoading(false);}
    },[businessId]);
    useEffect(()=>{
        const controller=new AbortController();scope.current=controller;
        // Schedule the next poll only when the previous one has finished.
        let timer:ReturnType<typeof setTimeout>;
        const poll=()=>{timer=setTimeout(()=>{void refresh(controller.signal).finally(()=>{if(!controller.signal.aborted)poll();});},5000);};
        void refresh(controller.signal).finally(()=>{if(!controller.signal.aborted)poll();});
        const ticker=setInterval(()=>setClock(Date.now()),1000);
        return ()=>{controller.abort();clearTimeout(timer);clearInterval(ticker);};
    },[refresh]);
    const wait=async(op:Operation,signal:AbortSignal,getOperation=getPhoneOperation):Promise<Operation>=>{
        let current=op;
        for(let n=0;n<45;n++) {
            if(signal.aborted)throw new Error('aborted');
            if(['done','failed','manual','canceled'].includes(current.state)) {
                if(current.state!=='done')throw {code:current.errorCode || 'TELEPHONY_OPERATION_FAILED'};
                return current;
            }
            await new Promise<void>((resolve,reject)=>{
                const abort=()=>{clearTimeout(timer);reject(new Error('aborted'));};
                const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1500);
                signal.addEventListener('abort',abort,{once:true});
            });
            if(signal.aborted)throw new Error('aborted');
            current=await getOperation(businessId,op.id,signal);
        }
        throw {code:'TELEPHONY_WAITING'};
    };
    const loadExisting=async()=>{
        const signal=scope.current?.signal;
        if(actionLock.current || !signal || signal.aborted || !data?.canManage || !data.canImport || pendingImport)return;
        actionLock.current=true;setBusy(true);setError('');setMessage('');setConfirmUnused(false);
        try {
            let inventory=await getExistingPhones(businessId,signal);
            if(inventory.operation){
                setMessage('Проверяем список разрешённых номеров у оператора…');
                await wait(inventory.operation,signal,getExistingPhoneOperation);
                inventory=await getExistingPhones(businessId,signal);
                if(inventory.operation)throw {code:'TELEPHONY_WAITING'};
            }
            if(!Array.isArray(inventory.candidates))throw {code:'TELEPHONY_OPERATION_FAILED'};
            const candidates=inventory.candidates.filter(candidate=>/^7\d{10}$/.test(candidate.number)
                && Array.isArray(candidate.modes) && candidate.modes.some(mode=>mode==='sip' || mode==='inbound_only'));
            if(!signal.aborted){
                const first=candidates.find(candidate=>!candidate.alreadyBound);
                setExisting(candidates);setExistingUpdated(inventory.updatedAt || null);
                setImportNumber(first?.number || '');setImportMode(first?.modes.includes('sip')?'sip':'inbound_only');
                setMessage(first?'Выберите номер и подтвердите, что он доступен для подключения к AVA.':'Нет доступных номеров с разрешением для этого бизнеса. Обратитесь в поддержку AVA.');
            }
        }catch(e){if(!signal.aborted)setError(telephonyError(e));}
        finally{actionLock.current=false;if(!signal.aborted)setBusy(false);}
    };
    const bindExisting=async(retry?:PendingImport)=>{
        const signal=scope.current?.signal;
        const candidate=existing?.find(item=>item.number===importNumber && !item.alreadyBound);
        if(actionLock.current || !signal || signal.aborted || !data?.canManage || !data.canImport
            || (!retry && (pendingImport || !confirmUnused || !candidate?.modes.includes(importMode) || candidate.forwardingReady===false)))return;
        const attempt=retry || {input:{number:importNumber,mode:importMode,confirmUnused:true as const},key:crypto.randomUUID()};
        actionLock.current=true;setBusy(true);setError('');setMessage('');setPendingImport(attempt);persistImport(businessId,attempt);
        try {
            await importExistingPhone(businessId,attempt.input,attempt.key,signal);
            persistImport(businessId,null);
            if(!signal.aborted){
                setPendingImport(null);setExisting(null);setConfirmUnused(false);
                setMessage('Заявка на привязку принята. AVA проверит существующий номер и покажет результат подключения ниже.');
                await refresh(signal);
            }
        }catch(e){
            const status=(e as {response?:{status?:number}})?.response?.status;
            if(status && status>=400 && status<500 && status!==408 && status!==429){
                persistImport(businessId,null);if(!signal.aborted)setPendingImport(null);
            }
            if(!signal.aborted)setError(telephonyError(e));
        }finally{actionLock.current=false;if(!signal.aborted)setBusy(false);}
    };
    const loadCatalog=async()=>{
        const signal=scope.current?.signal;
        if(actionLock.current || !signal || signal.aborted || !data?.canManage || !data.canPurchase || pending)return;
        actionLock.current=true;setBusy(true);setError('');setMessage('');
        try {
            const response=await getPhoneCatalog(businessId,signal);
            const result=response.operation?(await wait(response.operation,signal)).result:response;
            if(!result?.types?.length || !result.regions?.length)throw {code:'TELEPHONY_CATALOG_INVALID'};
            if(!signal.aborted){
                setCatalog({types:result.types,regions:result.regions});
                setType(result.types[0].type_id);setRegion(result.regions[0].id);
            }
        }catch(e){if(!signal.aborted)setError(telephonyError(e));}
        finally{actionLock.current=false;if(!signal.aborted)setBusy(false);}
    };
    const search=async()=>{
        const signal=scope.current?.signal;
        if(actionLock.current || !signal || signal.aborted || !data?.canManage || !data.canPurchase || pending)return;
        actionLock.current=true;setSearching(true);setError('');setMessage('');setSelected(null);setQuotes([]);
        try {
            const result=await wait(await findPhones(businessId,typeId,regionId,signal),signal);
            const available=(result.result?.quotes || []).filter(q=>Number.isSafeInteger(q.installKopecks) && q.installKopecks>=0
                && Number.isSafeInteger(q.monthlyKopecks) && q.monthlyKopecks>=0 && Number.isFinite(q.expiresAt));
            if(!signal.aborted){setQuotes(available);setMessage(available.length?'Выберите номер и подтвердите стоимость.':'Подходящих номеров в этом регионе сейчас нет. Попробуйте другой регион.');}
        }catch(e){if(!signal.aborted)setError(telephonyError(e));}
        finally{actionLock.current=false;if(!signal.aborted)setSearching(false);}
    };
    const purchase=async(retry?:PendingPurchase)=>{
        const signal=scope.current?.signal;
        const quote=retry?.quote || selected;
        if(!quote || actionLock.current || !signal || signal.aborted || !data?.canManage
            || !data.canPurchase || (!retry && (pending || quote.expiresAt<=Date.now())))return;
        actionLock.current=true;setBusy(true);setError('');setMessage('');
        const key=retry?.key || keys.current.get(quote.id) || crypto.randomUUID();keys.current.set(quote.id,key);
        const attempt={quote,key};
        // Persist before sending: a lost response must never become a fresh purchase on remount.
        setPending(attempt);persistPending(businessId,attempt);
        try {
            await buyPhone(businessId,quote.id,key,signal);
            persistPending(businessId,null);
            if(!signal.aborted){setPending(null);setSelected(null);setQuotes([]);setMessage('Заказ принят. AVA подключит номер автоматически; ход подключения показан ниже.');await refresh(signal);}
        }catch(e){
            const status=(e as {response?:{status?:number}})?.response?.status;
            if(status && status>=400 && status<500 && status!==408 && status!==429){
                persistPending(businessId,null);
                if(!signal.aborted){
                    setPending(null);
                    const code=(e as {response?:{data?:{code?:string}}})?.response?.data?.code;
                    if(['TELEPHONY_PRICE_CHANGED','TELEPHONY_QUOTE_EXPIRED','TELEPHONY_NUMBER_NO_LONGER_FREE'].includes(code || '')){
                        setSelected(null);setQuotes([]);
                    }
                }
            }
            if(!signal.aborted)setError(telephonyError(e));
        }
        finally{actionLock.current=false;if(!signal.aborted)setBusy(false);}
    };
    const change=async(fn:(signal:AbortSignal)=>Promise<unknown>)=>{
        const signal=scope.current?.signal;
        if(actionLock.current || !signal || signal.aborted || !data?.canManage)return;
        actionLock.current=true;setBusy(true);setError('');setMessage('');
        try{await fn(signal);if(!signal.aborted)await refresh(signal);}
        catch(e){if(!signal.aborted)setError(telephonyError(e));}
        finally{actionLock.current=false;if(!signal.aborted)setBusy(false);}
    };
    return <section id="ava-channel-panel" className="ava-channel-config ava-telephony" aria-labelledby="telephony-title">
        <div className="ava-telephony-heading"><div><p className="ava-channels-kicker">ЗВОНКИ В AVA</p><h2 id="telephony-title"><PhoneIcon size={21} aria-hidden="true"/> Телефония</h2>
            <p>Номер вашего бизнеса для входящих звонков и исходящих кампаний. AVA подключит его к вашему AI и CRM.</p></div>
            <button type="button" onClick={()=>{if(scope.current)void refresh(scope.current.signal);}} aria-label="Обновить состояние телефонии"><RefreshCw size={18} aria-hidden="true"/></button></div>
        {!data?<p role="status">{loading?'Загружаем телефонию…':'Состояние телефонии недоступно. Нажмите кнопку обновления, чтобы повторить проверку.'}</p>:<>
            <p className="ava-telephony-usage">{data.numbers.length} из {data.limits.numbers} номеров · Осталось {Math.floor(data.remainingSeconds/60)} мин {data.remainingSeconds%60} сек исходящих сегодня</p>
            <p className="ava-channel-hint">Один исходящий звонок одновременно, до 5 минут. Суточный лимит обновляется в 00:00 по Москве. Разговоры оплачиваются отдельно от абонентской платы.</p>
            {!data.canPurchase && <p className="ava-channel-hint">Покупка новых номеров сейчас недоступна. Состояние существующих подключений показано ниже.</p>}
            <details className="ava-telephony-diagnostics"><summary>Проверка подключения</summary><p className="ava-channel-hint" role="status">{data.health
                ?`Последняя проверка AVA: входящий маршрут ${data.health.ingressReady===true?'готов':'не подтверждён'}, запись разговоров ${data.health.recordingReady===true?'готова':'не подтверждена'}. Проверено ${new Date(data.health.checkedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} (МСК). Это сохранённый результат проверки; реальные звонки подтверждаются отдельно.`
                :'Проверка входящего маршрута и записи разговоров ещё не получена. Готовность связи подтвердит тестовый звонок.'}</p></details>
            {data.canManage && data.connectionPaths?.some(path=>path.kind==='own_sip'&&path.blocker==='TELEPHONY_EXTERNAL_SIP_REQUIRES_OPERATOR') && !data.externalSip && <p className="ava-channel-hint">Чтобы подключить номер другого оператора, обратитесь в поддержку AVA. Уже подключённые номера продолжают работать.</p>}
            {data.numbers.length===0 && <p>Подключите номер, чтобы AVA принимала звонки.</p>}
            {data.connections?.filter(connection=>connection.businessId===businessId&&!data.numbers.some(phone=>phone.id===connection.id)).map(connection=><div key={connection.id} className="ava-telephony-manual" aria-label="Существующее подключение"><h3>Ваш номер · +{connection.number}</h3><p>{connection.inbound.configured?'Входящие настроены':'Входящие не настроены'} · {connection.outbound.configured?'Исходящие настроены':'Исходящие не настроены'}</p><p className="ava-channel-hint">{connection.inbound.available===true?'Входящее подключение доступно. ':connection.inbound.available===false?'Входящее подключение недоступно. ':'Связь входящего номера ещё не подтверждена. '}{connection.outbound.available===true?'Исходящее подключение доступно.':connection.outbound.available===false?'Исходящее подключение недоступно.':'Связь исходящего номера ещё не подтверждена.'}</p><p className="ava-channel-hint">{connection.inbound.verifiedAt?'Входящий звонок получен.':'Проверьте звук и ответ AVA тестовым звонком.'}</p></div>)}
            {!data.managedMode && !data.connections?.length && <ManualPhoneSummary businessId={businessId} canManage={data.canManage}/>}
            <ul className="ava-telephony-numbers" aria-label="Номера бизнеса">{data.numbers.filter(phone=>phone.origin!=='external').map(phone=><li key={phone.id}>
                <div className="ava-telephony-number-heading"><strong>+{phone.number}</strong><span>{phone.isPrimary?'Основной · ':''}{phone.origin==='existing' && ['grace','releasing'].includes(phone.state)?'Ожидает отключения от AVA':labels[phone.state] || 'Проверяется'}</span></div>
                {phone.origin==='existing'?<p>Существующий номер Exolve · условия оплаты сохраняются у оператора.</p>:<p>{money(phone.monthlyKopecks)} / месяц · подключение {money(phone.installKopecks)}</p>}
                <p>Входящие: {phone.state==='active' && phone.inboundReady?'настроены':'недоступны'} · Исходящие: {phone.state==='active' && phone.outboundReady?'настроены':'недоступны'}</p>
                <p className="ava-channel-hint">Реальные звонки: входящий {phone.inboundVerifiedAt?'получен':'ещё не получен'}, исходящий {phone.outboundVerifiedAt?'состоялся':'ещё не состоялся'}. Проверьте звук и ответы AI тестовым звонком.</p>
                {phone.releaseAt && <p role="status">{phone.origin==='existing'?'Привязка к AVA будет отключена ':'Номер будет освобождён '}{new Date(phone.releaseAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' (МСК)'}. {phone.origin==='existing'?'Номер и подключение останутся у оператора.':'После этого восстановление номера не гарантируется.'}</p>}
                {data.canManage && <div className="ava-channel-actions">
                    {phone.state==='active' && !phone.isPrimary && <button type="button" disabled={busy} onClick={()=>void change(signal=>setPrimaryPhone(businessId,phone.id,signal))}>Сделать основным</button>}
                    {phone.state==='active' && <button type="button" disabled={busy} onClick={()=>{
                        if(window.confirm(phone.origin==='existing'?`Отключить +${phone.number} от AVA? Новые звонки в AVA прекратятся сразу, привязка будет снята через 7 дней. Номер и SIP сохранятся у оператора. До снятия привязки можно отменить отключение.`:`Отключить +${phone.number}? Новые звонки прекратятся сразу, номер освободится через 7 дней. До освобождения можно отменить отключение.`))void change(signal=>releasePhone(businessId,phone.id,false,signal));
                    }}>{phone.origin==='existing'?'Отключить от AVA через 7 дней':'Освободить через 7 дней'}</button>}
                    {phone.state==='grace' && <button type="button" disabled={busy} onClick={()=>void change(signal=>releasePhone(businessId,phone.id,true,signal))}>Отменить отключение</button>}
                </div>}
            </li>)}</ul>
            {data.orders.filter(op=>!['done','canceled'].includes(op.state)).map(op=><p key={op.id} className="ava-telephony-progress" role="status">
                {op.kind==='release'?'Отключение номера: ':op.kind==='import'?'Привязка существующего номера: ':'Подключение номера: '}{op.state==='manual'?'Операцию проверяет поддержка AVA':op.state==='failed'?'Операция не завершена':stages[op.stage] || 'Проверяем состояние операции'}
                {op.state==='reconciling'?' · Ожидаем подтверждения оператора; повторное действие не требуется.':''}
                {op.errorCode && ['failed','manual','reconciling','pending'].includes(op.state)?` · ${telephonyError({code:op.errorCode})}`:''}</p>)}
            {data.canManage && data.canImport && !pendingImport && <div className="ava-telephony-existing">
                <h3>Подключить существующий номер</h3>
                <p className="ava-channel-hint">Доступны только номера, разрешённые поддержкой AVA для этого бизнеса. Номер уже должен быть настроен у оператора. Новые номера и подключения не приобретаются.</p>
                <button type="button" disabled={busy} onClick={()=>void loadExisting()}>{busy?'Проверяем номера…':existing?'Обновить разрешённые номера':'Показать разрешённые номера'}</button>
                {existing && existing.length>0 && <form onSubmit={event=>{event.preventDefault();void bindExisting();}}>
                    <div className="ava-channel-fields"><label><span>Существующий номер</span>
                        <select ref={existingSelect} value={importNumber} disabled={busy} onChange={event=>{
                            const next=existing.find(item=>item.number===event.target.value);setImportNumber(event.target.value);
                            setImportMode(next?.modes.includes('sip')?'sip':'inbound_only');setConfirmUnused(false);
                        }}><option value="" disabled>Выберите номер</option>{existing.map(item=><option key={item.number} value={item.number} disabled={item.alreadyBound}>+{item.number}{item.alreadyBound?' · уже привязан':''}</option>)}</select>
                    </label><label><span>Направления звонков</span><select value={importMode} disabled={busy || !importNumber} onChange={event=>{setImportMode(event.target.value as ExistingMode);setConfirmUnused(false);}}>
                        {existing.find(item=>item.number===importNumber)?.modes.filter(mode=>mode==='sip' || mode==='inbound_only').map(mode=><option key={mode} value={mode}>{mode==='sip'?'Входящие и исходящие':'Только входящие'}</option>)}
                    </select></label></div>
                    {importNumber && <>
                        {existing.find(item=>item.number===importNumber)?.forwardingReady===false && <p role="alert" className="ava-telephony-error">{telephonyError({code:'TELEPHONY_IMPORT_FORWARDING_REQUIRED'})}</p>}
                        {existing.find(item=>item.number===importNumber)?.sipAvailable===false && <p className="ava-channel-hint">{telephonyError({code:'TELEPHONY_IMPORT_SIP_REQUIRED'})}</p>}
                        {importMode==='inbound_only' && <p className="ava-channel-hint">Этот режим принимает только входящие звонки. Использовать номер для исходящих кампаний нельзя.</p>}
                        <label className="ava-telephony-attestation"><input type="checkbox" checked={confirmUnused} disabled={busy} onChange={event=>setConfirmUnused(event.target.checked)}/>
                            <span>{importMode==='sip'?'Подтверждаю, что номер и его SIP-подключение доступны для AVA и не используются другим сервисом.':'Подтверждаю, что номер доступен для AVA и не используется другим сервисом.'}</span>
                        </label>
                        <button type="submit" className="ava-channel-primary" disabled={busy || !confirmUnused || existing.find(item=>item.number===importNumber)?.forwardingReady===false}>Подключить +{importNumber} к AVA</button>
                    </>}
                </form>}
                {existingUpdated && <p className="ava-channel-hint">Список проверен {new Date(existingUpdated).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} (МСК).</p>}
            </div>}
            {pendingImport && <div className="ava-telephony-confirm" role="status">
                <p>Результат привязки +{pendingImport.input.number} пока не подтверждён. Проверка использует прежнюю заявку и не создаёт ресурсы у оператора.</p>
                {data.canManage && data.canImport && <button ref={importRetry} type="button" disabled={busy} onClick={()=>void bindExisting(pendingImport)}>Проверить прежнюю привязку</button>}
            </div>}
            {data.canManage && data.canPurchase && !pending && !catalog && <button type="button" className="ava-channel-primary" disabled={busy} onClick={()=>void loadCatalog()}>{busy?'Загружаем варианты…':'Купить номер'}</button>}
            {data.canManage && data.canPurchase && !pending && catalog && <form onSubmit={event=>{event.preventDefault();void search();}}>
                <div className="ava-channel-fields"><label><span>Тип номера</span><select ref={typeSelect} value={typeId} onChange={e=>{setType(Number(e.target.value));setSelected(null);setQuotes([]);}} disabled={busy || searching}>
                    {catalog.types.map(t=><option key={t.type_id} value={t.type_id}>{t.type_name || (t.type_id===1104?'Мобильный':'Городской')}</option>)}</select></label>
                    <label><span>Регион</span><select value={regionId} onChange={e=>{setRegion(Number(e.target.value));setSelected(null);setQuotes([]);}} disabled={busy || searching}>
                        {catalog.regions.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label></div>
                <button type="submit" disabled={busy || searching || !regionId || !typeId}>{searching?'Ищем номера…':'Найти номера'}</button>
                {!!quotes.length && <fieldset className="ava-telephony-offers"><legend>Доступные номера — цены включают подключение телефонии</legend>{quotes.map(q=><label key={q.id} className={selected?.id===q.id?'is-selected':''}>
                    <input type="radio" name="phone-offer" value={q.id} checked={selected?.id===q.id} onChange={()=>setSelected(q)} disabled={q.expiresAt<=clock || busy} aria-describedby={`offer-price-${q.id}`}/>
                    <span><strong>+{q.number}</strong><small id={`offer-price-${q.id}`}>Подключение {money(q.installKopecks)} · {money(q.monthlyKopecks)} / месяц</small>{q.expiresAt<=clock?<small>Предложение истекло. Найдите номера заново.</small>:<small aria-hidden="true">Действует ещё {Math.ceil((q.expiresAt-clock)/1000)} сек</small>}</span></label>)}</fieldset>}
                {selected && <div className="ava-telephony-confirm"><p>Покупка +{selected.number}: подключение <strong>{money(selected.installKopecks)}</strong>, затем <strong>{money(selected.monthlyKopecks)} / месяц</strong>. Подключение и первый месяц: <strong>{money(selected.installKopecks+selected.monthlyKopecks)}</strong>. Платформа AVA оплатит заказ из баланса пилота. Стоимость разговоров учитывается отдельно.</p>
                    <button type="button" className="ava-channel-primary" onClick={()=>void purchase()} disabled={busy || selected.expiresAt<=clock}>{busy?'Создаём заказ…':`Подтвердить покупку +${selected.number}`}</button></div>}
            </form>}
            {pending && <div className="ava-telephony-confirm" role="status">
                <p>Результат заказа +{pending.quote.number} пока не подтверждён. Повторная проверка использует тот же заказ, даже если предложение уже истекло.</p>
                <p>Подключение {money(pending.quote.installKopecks)} · {money(pending.quote.monthlyKopecks)} / месяц · первый платёж {money(pending.quote.installKopecks+pending.quote.monthlyKopecks)}.</p>
                {data.canManage && data.canPurchase && <button ref={retryButton} type="button" disabled={busy} onClick={()=>void purchase(pending)}>{busy?'Проверяем заказ…':'Проверить тот же заказ'}</button>}
            </div>}
            {data.canManage && data.pilotEnabled && !data.canPurchase && data.numbers.length>=data.limits.numbers && <p className="ava-channel-hint">Достигнут лимит номеров. Подключения в обработке и номера, ожидающие освобождения, также занимают место.</p>}
            {data.canManage && data.canPurchase && !data.balanceReady && <p className="ava-channel-hint">Проверка баланса платформы ещё выполняется. Доступность оплаты будет проверена перед заказом.</p>}
            {data.notices.map((notice,index)=><p key={`${notice.code}:${notice.phoneId}:${index}`} className="ava-telephony-progress" role="status">
                {notice.code==='TELEPHONY_RELEASE_WARNING'?data.numbers.find(p=>p.id===notice.phoneId)?.origin==='existing'?'До снятия привязки к AVA осталось не больше трёх дней. Отмените отключение, если номер ещё нужен. У оператора номер сохранится.':'До освобождения номера осталось не больше трёх дней. Отмените отключение, если номер ещё нужен.':notice.code==='TELEPHONY_PRICE_DRIFT'?'Стоимость у оператора изменилась. Поддержка AVA проверяет условия номера.':'Поддержка AVA проверяет состояние номера и его подключение.'}
                {data.numbers.find(p=>p.id===notice.phoneId) && ` Номер +${data.numbers.find(p=>p.id===notice.phoneId)!.number}.`}
            </p>)}
            <ExternalSipSettings businessId={businessId} data={data} onChanged={()=>{if(scope.current && !scope.current.signal.aborted)void refresh(scope.current.signal);}} />
            {!data.canManage && <p className="ava-channel-hint">Управлять номерами может владелец бизнеса.</p>}
        </>}
        {message && <p ref={feedback} tabIndex={-1} role="status" className="ava-channel-feedback">{message}</p>}
        {(error || loadError) && <p role="alert" className="ava-telephony-error">{error || loadError}</p>}
    </section>;
}
