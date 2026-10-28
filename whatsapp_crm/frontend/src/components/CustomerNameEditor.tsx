import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {Pencil} from 'lucide-react';
import {renameSalesClient} from '../api';
import {customerDisplayName} from '../customerDisplay';
import './CustomerNameEditor.css';

type Props = {businessId:number; chatId:string; name:string; phone?:string|null;
    canEdit:boolean; heading:'h1'|'h2'; headingId?:string; onSaved:(name:string)=>void};
export default function CustomerNameEditor({businessId,chatId,name,phone,canEdit,heading:Heading,headingId,onSaved}:Props) {
    const id=useId(), trigger=useRef<HTMLButtonElement>(null), field=useRef<HTMLInputElement>(null);
    const life=useRef<AbortController|null>(null), lock=useRef(false), previousName=useRef(name), restoreFocus=useRef(false);
    const [editing,setEditing]=useState(false), [draft,setDraft]=useState(''), [busy,setBusy]=useState(false);
    const [error,setError]=useState(''), [notice,setNotice]=useState('');
    const [saved,setSaved]=useState<{original:string;value:string}|null>(null);
    const current=saved && name===saved.original?saved.value:name;
    useEffect(()=>{const controller=new AbortController();life.current=controller;return()=>controller.abort();},[]);
    useEffect(()=>{if(editing) {field.current?.focus();field.current?.select();}},[editing]);
    useEffect(()=>{if(restoreFocus.current&&!editing&&!busy){trigger.current?.focus();restoreFocus.current=false;}},[editing,busy]);
    function close() {restoreFocus.current=true;setEditing(false);setError('');}
    async function save(event:FormEvent) {
        event.preventDefault(); if(lock.current||!canEdit) return;
        const trimmed=draft.trim();
        if(!trimmed||trimmed.length>180||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(draft)) {
            setError('Введите имя от 1 до 180 символов в одну строку.');field.current?.focus();return;
        }
        const signal=life.current!.signal;lock.current=true;setBusy(true);setError('');setNotice('');
        try {
            const result=await renameSalesClient(businessId,chatId,trimmed,previousName.current,signal);
            if(signal.aborted) return;
            if(!result.success||result.businessId!==businessId||result.client?.chatId!==chatId||result.client.name!==trimmed) throw Error('INVALID_RESPONSE');
            setSaved({original:name,value:result.client.name});close();setNotice('Имя сохранено.');onSaved(result.client.name);
        } catch(cause) {
            if(signal.aborted) return;
            const code=(cause as {response?:{data?:{code?:string}}})?.response?.data?.code;
            setError(code==='SALES_CLIENT_NAME_CHANGED'?'Имя уже изменили. Обновите карточку и повторите изменение.':
                code==='SALES_CLIENT_NAME_INVALID'?'Введите имя от 1 до 180 символов в одну строку.':
                code==='SALES_CLIENT_CLAIM_REQUIRED'?'Сначала возьмите клиента в работу.':
                ['SALES_CLIENT_SCOPE_DENIED','BUSINESS_ACCESS_DENIED','CAPABILITY_DENIED'].includes(code||'')?'Доступ изменился. Обновите карточку и проверьте ответственного.':
                'Не удалось сохранить имя. Проверьте соединение и повторите попытку.');
            field.current?.focus();
        } finally {lock.current=false;if(!signal.aborted) setBusy(false);}
    }
    return <div className="customer-name">
        <div className="customer-name__title"><Heading id={headingId} tabIndex={headingId?-1:undefined}>{customerDisplayName(current,phone,chatId)}</Heading>
            {canEdit&&<button ref={trigger} type="button" className="customer-name__edit" disabled={busy} aria-expanded={editing} aria-controls={id} onClick={()=>{previousName.current=current;setDraft(current);setError('');setNotice('');setEditing(!editing);}}><Pencil size={14} aria-hidden="true"/>Изменить имя</button>}
        </div>
        {editing&&canEdit&&<form id={id} className="customer-name__form" onSubmit={event=>void save(event)} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.preventDefault();close();}}} aria-busy={busy}>
            <label htmlFor={`${id}-input`}>Имя клиента</label>
            <input ref={field} id={`${id}-input`} name="customer-name" autoComplete="off" value={draft} maxLength={180} readOnly={busy} aria-invalid={!!error} aria-describedby={error?`${id}-error`:undefined} onChange={event=>{setDraft(event.target.value);setError('');}}/>
            <div className="customer-name__actions"><button type="submit" disabled={busy}>{busy?'Сохраняем…':'Сохранить имя'}</button><button type="button" disabled={busy} onClick={close}>Отмена</button></div>
            {error&&<p id={`${id}-error`} role="alert">{error}</p>}
        </form>}
        <span className="customer-name__notice" role="status">{notice}</span>
    </div>;
}
