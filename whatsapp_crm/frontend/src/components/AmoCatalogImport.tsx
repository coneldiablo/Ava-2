import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { getAmoCatalog, previewAmoCatalog, publishAmoCatalog, saveAmoCatalogSchedule, type AmoCatalogMapping } from '../amoCatalogApi';
import { moneyMinor } from '../avaWorkspace';
import { useBusinessAccess } from '../permissions';
import { useAction, useResource } from '../hooks/useWorkspaceResource';
import { Feedback } from './WorkspaceUi';
import './CatalogImport.css';
import './AmoCatalogImport.css';
const labels: Record<string,string> = { EXTERNAL_CATALOG_CURRENCY_REQUIRED:'Подтвердите валюту цены', EXTERNAL_CATALOG_PRICE_INVALID:'Цена отсутствует или некорректна', EXTERNAL_CATALOG_NAME_INVALID:'Некорректное название', EXTERNAL_CATALOG_UNIT_INVALID:'Некорректная единица измерения', EXTERNAL_CATALOG_DESCRIPTION_INVALID:'Некорректное описание' };
const date = (value?: string) => value ? new Date(value).toLocaleString('ru-RU') : 'Ещё не проверялось';
type Props = { businessId: number; connected?: boolean; onChanged?: () => void };
export default function AmoCatalogImport(props: Props) {
 const access = useBusinessAccess();
 if (!access.can('business.manage')) return null;
 return <AmoCatalogFlow key={`${props.businessId}:${access.userId}`} {...props} />;
}
function AmoCatalogFlow({ businessId, connected, onChanged }: Props) {
 const action = useAction();
 const resource = useResource(`amo-catalog:${businessId}:${connected}`, async signal => {
  const [catalog, integration] = await Promise.all([getAmoCatalog(businessId, signal), connected === undefined ? api.get(`/external-integrations/${businessId}/amocrm`, { signal, timeout:20000 }) : Promise.resolve(null)]);
  const connection = integration?.data?.integration;
  return { catalog, connected: connected ?? (!!connection?.account && !['disconnected', 'reauth_required'].includes(connection.status)) };
 });
 const [mapping,setMapping] = useState({catalogId:'',priceFieldId:'',unitFieldId:'',currency:''});
 const [enabled,setEnabled] = useState(false), [interval,setInterval] = useState(60), [uncertain,setUncertain] = useState(false);
 const catalog=resource.data?.catalog, preview=catalog?.preview, publication=catalog?.publication;
 useEffect(()=>{if(catalog){setEnabled(catalog.settings.enabled);setInterval(catalog.settings.intervalMinutes);}},[catalog]);
 useEffect(()=>{if(preview){const value=preview.mapping;setMapping({catalogId:String(value.catalogId||''),priceFieldId:String(value.priceFieldId||''),unitFieldId:String(value.unitFieldId||''),currency:value.currency||''});}},[preview?.previewId]);
 const busy=!!action.busy||resource.loading, published=!!preview&&publication?.previewId===preview.previewId;
 function change(key:keyof typeof mapping,value:string){setMapping(previous=>({...previous,[key]:value}));}
 function readback(){resource.reload();onChanged?.();}
 function prepare(event:FormEvent){event.preventDefault();const input:AmoCatalogMapping={};for(const key of ['catalogId','priceFieldId','unitFieldId'] as const)if(mapping[key])input[key]=Number(mapping[key]);if(mapping.currency)input.currency=mapping.currency;
  void action.run('preview',async signal=>{setUncertain(true);await previewAmoCatalog(businessId,input,signal);setUncertain(false);readback();return 'Предпросмотр сохранён. Проверьте цены перед публикацией.';});}
 return <details className="catalog-import amo-catalog" open><summary>Товары и цены из amoCRM</summary><div className="catalog-import-panel" aria-busy={busy}>
 <header><div><h3>Каталог amoCRM</h3><p>Опубликованные товары появятся в общем каталоге AVA, у ассистента, в предложениях и счетах.</p></div></header><Feedback {...action}/>
 {resource.loading&&<p role="status">Проверяем подключение и сохранённые цены…</p>}{resource.error&&<p role="alert">{resource.error}</p>}
 <button type="button" className="btn-secondary" disabled={!!action.busy} onClick={readback}>Проверить сохранённое состояние</button>
 {resource.data&&!resource.data.connected&&<p>Для загрузки товаров подключите amoCRM. <Link to="/channels?channel=amocrm">Открыть подключение amoCRM</Link></p>}
 {resource.data?.connected&&<>
 <form onSubmit={prepare}><fieldset disabled={busy||uncertain}><legend>Источник товаров</legend><div className="catalog-import-columns">
 <label>Каталог товаров: ID (необязательно)<input type="number" min="1" step="1" value={mapping.catalogId} onChange={e=>change('catalogId',e.target.value)} placeholder="Каталог товаров amoCRM"/></label>
 <label>Валюта, если источник её не передаёт<select aria-label="Валюта, если источник её не передаёт" value={mapping.currency} onChange={e=>change('currency',e.target.value)}><option value="">Только валюта из amoCRM</option>{['RUB','USD','EUR','KZT','BYN'].map(value=><option key={value}>{value}</option>)}</select></label></div>
 <details><summary>Сопоставление полей</summary><div className="catalog-import-columns"><label>ID поля цены<input type="number" min="1" step="1" value={mapping.priceFieldId} onChange={e=>change('priceFieldId',e.target.value)} placeholder="Стандартное поле PRICE"/></label><label>ID поля единицы измерения<input type="number" min="1" step="1" value={mapping.unitFieldId} onChange={e=>change('unitFieldId',e.target.value)} placeholder="Стандартное поле UNIT"/></label></div></details>
 <button className="btn-secondary" type="submit">{action.busy==='preview'?'Загружаем товары…':'Загрузить актуальные товары и цены'}</button></fieldset></form>
 {uncertain&&<p role="alert">Ответ не подтверждён. Проверьте сохранённое состояние перед следующей загрузкой. <button className="btn-secondary" disabled={busy} onClick={()=>void action.run('check',async signal=>{await getAmoCatalog(businessId,signal);setUncertain(false);readback();return 'Сохранённое состояние проверено.';})}>Проверить результат операции</button></p>}
 {preview&&<section aria-label="Предпросмотр товаров amoCRM"><h4>{preview.catalogName||'Товары'} · {preview.items.length}</h4><p>Источник цены: amoCRM · Проверено: {date(preview.checkedAt)}</p><p>Аккаунт {preview.accountId} · Каталог {preview.catalogId}. Публикация обновит связанные товары; ручные изменения будут пропущены.</p>
 {!preview.items.length?<p>В каталоге amoCRM нет товаров.</p>:<div className="catalog-import-table" tabIndex={0} role="region" aria-label="Товары и исходные цены"><table><caption>Цены из сохранённого предпросмотра</caption><thead><tr><th>Товар</th><th>Цена</th><th>Единица</th><th>Проверка</th></tr></thead><tbody>{preview.items.map(item=><tr key={item.elementId}><td>{item.offer?.name||`Товар ${item.elementId}`}{item.source.sku&&<small> · {item.source.sku}</small>}</td><td>{item.offer?.amountMinor!=null&&item.offer.currency?moneyMinor(item.offer.amountMinor,item.offer.currency):'Цена не подтверждена'}</td><td>{item.source.unit||'—'}</td><td>{item.manuallyChanged?'Конфликт: изменён вручную':item.retired?'Будет снят с публикации':item.errors.length?item.errors.map(code=>labels[code]||'Проверьте данные товара').join('; '):'Готов к публикации'}</td></tr>)}</tbody></table></div>}
 <button type="button" className="btn-primary" disabled={busy||uncertain||published||!preview.items.length} onClick={()=>void action.run('publish',async signal=>{setUncertain(true);await publishAmoCatalog(businessId,preview.previewId,signal);setUncertain(false);readback();return 'Результат публикации сохранён в общем каталоге AVA.';})}>{published?'Этот предпросмотр опубликован':'Опубликовать товары и цены'}</button></section>}
 {publication&&<section aria-label="Результат публикации amoCRM"><h4>Результат публикации · {date(publication.publishedAt)}</h4><p>Обновлено: {publication.results.filter(r=>r.status==='published').length} · Без изменений: {publication.results.filter(r=>r.status==='unchanged').length} · Снято: {publication.results.filter(r=>r.status==='retired').length} · Пропущено: {publication.results.filter(r=>r.status==='skipped').length} · Конфликты: {publication.results.filter(r=>r.status==='conflict').length}</p><Link to="/autopilot?tab=catalog">Открыть общий каталог</Link></section>}
 {!!catalog?.sources.length&&<><p>Связанных товаров: {catalog.sources.length} · {catalog.sources.some(r=>r.stale)?'Цены требуют обновления':'Источник проверен'}{catalog.sources.some(r=>r.localConflict)?' · Есть ручные изменения':''}</p><form onSubmit={e=>{e.preventDefault();void action.run('settings',async signal=>{setUncertain(true);await saveAmoCatalogSchedule(businessId,{enabled,intervalMinutes:interval},signal);setUncertain(false);readback();return 'Расписание обновления сохранено.';});}}><fieldset disabled={busy||uncertain}><label className="catalog-import-check"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/><span>Обновлять цены автоматически</span></label><p>Обновления amoCRM будут публиковаться по расписанию, включая новые и удалённые товары. Товары с ручными изменениями будут пропущены.</p><label>Интервал обновления, минуты<input type="number" min="5" max="1440" step="1" required value={interval} onChange={e=>setInterval(Number(e.target.value))}/></label><button className="btn-secondary">Сохранить расписание</button></fieldset></form></>}
 {catalog?.settings.lastError&&<p role="alert">Последнее автоматическое обновление не завершено. Проверьте подключение и загрузите актуальные товары вручную.</p>}
 </>}
 </div></details>;
}
