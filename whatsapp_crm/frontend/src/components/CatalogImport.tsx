import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { catalogImportRequest, type CatalogImport as Import, type CatalogImportInput, type CatalogMapping, type CatalogValidation } from '../catalogImportApi';
import { requestKey, moneyMinor } from '../avaWorkspace';
import { useAuth } from '../context/AuthContext';
import './CatalogImport.css';
const fields = [{ key: 'name', label: 'Название', required: true }, { key: 'price', label: 'Цена', required: true }, { key: 'sku', label: 'Артикул' }, { key: 'currency', label: 'Валюта' }, { key: 'description', label: 'Описание' }, { key: 'terms', label: 'Условия' }] as const;
const messages: Record<string, string> = { CATALOG_PREVIEW_EXPIRED: 'Предпросмотр устарел. Загрузите таблицу ещё раз.', CATALOG_ROLLBACK_CONFLICT: 'После импорта товары уже изменили. Автоматическая отмена недоступна — проверьте их в каталоге.', CATALOG_ROWS_INVALID: 'В таблице есть ошибки. Исправьте файл или явно разрешите импорт только корректных строк.', CATALOG_IMPORT_INPUT_INVALID: 'Проверьте сопоставление столбцов и параметры импорта.', CATALOG_IDEMPOTENCY_CONFLICT: 'Параметры запроса изменились. Обновите результат импорта перед продолжением.' };
function message(error: unknown) { const code = (error as { response?: { data?: { code?: string; error?: string } } })?.response?.data; return messages[code?.code || code?.error || ''] || 'Действие не подтверждено. Данные сохранены: проверьте результат или повторите запрос.'; }
export default function CatalogImport({ businessId, onChanged }: { businessId: number; onChanged: () => void }) {
    const { userId, loginName } = useAuth();
    const key = `ava:catalog-import:${userId || loginName}:${businessId}`;
    const [open, setOpen] = useState(false), [record, setRecord] = useState<Import | null>(null), [file, setFile] = useState<File | null>(null);
    const [mapping, setMapping] = useState<Partial<CatalogMapping>>({}), [mode, setMode] = useState<'add' | 'upsert'>('add'), [publish, setPublish] = useState(false), [partial, setPartial] = useState(false);
    const [validation, setValidation] = useState<CatalogValidation | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const running = useRef(false), active = useRef(true), controller = useRef<AbortController | null>(null), commitKey = useRef({ fingerprint: '', value: '' });
    const fileInput = useRef<HTMLInputElement>(null);
    useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
    async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
        if (running.current) return; running.current = true; setBusy(label); setError(''); setNotice(''); const request = new AbortController(); controller.current = request;
        try { await work(request.signal); } catch (cause) { if (active.current && !request.signal.aborted) setError(message(cause)); }
        finally { if (active.current) { running.current = false; setBusy(''); } }
    }
    function remember(value: Import) { if (!active.current) return; setRecord(value); try { sessionStorage.setItem(key, value.id); } catch { /* optional */ } }
    async function readback(id: string, signal: AbortSignal) { const result = await catalogImportRequest<{ import: Import }>(businessId, `/${encodeURIComponent(id)}`, undefined, signal); if (result.import.id !== id) throw new Error('scope'); remember(result.import); return result.import; }
    useEffect(() => {
        let id: string | null = null; try { id = sessionStorage.getItem(key); } catch { /* optional */ }
        if (!id || !/^[a-f\d-]{36}$/i.test(id)) return;
        let cancelled = false; const request = new AbortController(); controller.current = request;
        running.current = true; setOpen(true); setBusy('Проверяем предыдущий импорт…');
        void catalogImportRequest<{ import: Import }>(businessId, `/${encodeURIComponent(id)}`, undefined, request.signal).then(result => {
            if (!cancelled && result.import.id === id) remember(result.import);
        }).catch(cause => { if (!cancelled) setError(message(cause)); }).finally(() => { if (!cancelled) { running.current = false; setBusy(''); } });
        return () => { cancelled = true; request.abort(); running.current = false; };
        // This component is scoped by business and identity in its parent.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const input: CatalogImportInput | null = Number.isInteger(mapping.name) && Number.isInteger(mapping.price) ? { mapping: mapping as CatalogMapping, mode, publish, allowPartial: partial } : null;
    const changed = () => { setValidation(null); setError(''); setNotice(''); };
    return <section className="catalog-import" aria-label="Загрузка каталога из таблицы">
        <button className="aw-button" aria-expanded={open} onClick={() => setOpen(value => !value)}><Upload size={16} aria-hidden="true" />Загрузить таблицу</button>
        {open && <div className="catalog-import-panel" aria-busy={Boolean(busy)}>
            <header><div><h3>Товары и цены из таблицы</h3><p>Загрузите CSV или Excel, проверьте строки и сохраните в общий каталог бизнеса.</p></div><button type="button" className="aw-icon-button" aria-label="Закрыть импорт" disabled={Boolean(busy)} onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></header>
            {busy && <p role="status">{busy}</p>}{error && <p className="aw-alert" role="alert">{error}</p>}{notice && <p className="aw-notice" role="status">{notice}</p>}
            {(!record || record.status === 'rolled_back') && <form onSubmit={event => { event.preventDefault(); if (!file) return; void run('Читаем таблицу…', async signal => { const body = new FormData(); body.append('file', file); const result = await catalogImportRequest<{ import: Import }>(businessId, '/preview', body, signal); remember(result.import); setValidation(null); setMapping({}); }); }}>
                <label>Таблица товаров<input ref={fileInput} type="file" accept=".csv,.xlsx" disabled={Boolean(busy)} onChange={event => { const selected = event.target.files?.[0] || null; if (selected && (selected.size > 5 * 1024 * 1024 || !/\.(csv|xlsx)$/i.test(selected.name))) { setError('Выберите CSV или XLSX размером до 5 МБ.'); setFile(null); return; } setFile(selected); setError(''); }} /></label><p>Первая строка — названия столбцов. До 5000 товаров, размер до 5 МБ.</p><button className="aw-button aw-button-primary" disabled={!file || Boolean(busy)}>Открыть предпросмотр</button>
            </form>}
            {record?.status === 'preview' && <>
                <p><strong>{record.filename}</strong> · {record.rowCount} строк</p>
                <div className="catalog-import-columns">{fields.map(field => <label key={field.key}>{field.label}{'required' in field && field.required ? ' *' : ''}<select aria-label={`${field.label}${'required' in field && field.required ? ' *' : ''}`} aria-required={'required' in field && field.required || undefined} disabled={Boolean(busy)} value={mapping[field.key] ?? ''} onChange={event => { setMapping(value => { const next = { ...value }; if (event.target.value === '') delete next[field.key]; else next[field.key] = Number(event.target.value); return next; }); changed(); }}><option value="">{'required' in field && field.required ? 'Выберите столбец' : 'Не загружать'}</option>{record.columns.map(column => <option key={column.index} value={column.index}>{column.name}</option>)}</select></label>)}</div>
                <div className="catalog-import-table"><table><caption>Первые строки файла</caption><thead><tr><th>Строка</th>{record.columns.map(column => <th key={column.index}>{column.name}</th>)}</tr></thead><tbody>{record.preview.slice(0, 5).map(row => <tr key={row.row}><td>{row.row}</td>{row.cells.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody></table></div>
                <label>Если товар уже есть<select aria-label="Если товар уже есть" value={mode} disabled={Boolean(busy)} onChange={event => { setMode(event.target.value as 'add' | 'upsert'); changed(); }}><option value="add">Пропустить существующие</option><option value="upsert">Обновить по артикулу или названию</option></select></label>
                <label className="catalog-import-check"><input type="checkbox" checked={publish} disabled={Boolean(busy)} onChange={event => { setPublish(event.target.checked); changed(); }} /><span>Опубликовать товары и цены для ассистента. Без этой отметки они сохранятся черновиками.</span></label>
                <button className="aw-button" disabled={!input || Boolean(busy)} onClick={() => void run('Проверяем товары…', async signal => { const result = await catalogImportRequest<{ validation: CatalogValidation }>(businessId, `/${record.id}/validate`, input, signal); if (!active.current) return; setValidation(result.validation); })}>Проверить строки</button>
                {validation && <div><h4>Результат проверки</h4><p>Корректных: {validation.validCount}. С ошибками: {validation.errorCount}. Будет пропущено: {validation.skippedCount}.</p>{validation.errors.length > 0 && <><ul className="catalog-import-errors">{validation.errors.map(row => <li key={row.row}>Строка {row.row}: {row.messages.join('; ')}</li>)}</ul><label className="catalog-import-check"><input type="checkbox" checked={partial} disabled={Boolean(busy)} onChange={event => setPartial(event.target.checked)} /><span>Загрузить только корректные строки. Ошибочные останутся вне каталога.</span></label></>}
                    <ul>{validation.products.slice(0, 5).map(product => <li key={product.row}>{product.name} · {moneyMinor(product.amountMinor, product.currency)} · {product.operation === 'add' ? 'новый товар' : 'обновление'}</li>)}</ul>
                    <button className="aw-button aw-button-primary" disabled={Boolean(busy) || !input || !validation.validCount || (validation.errorCount > 0 && !partial)} onClick={() => void run('Сохраняем и проверяем каталог…', async signal => { const fingerprint = JSON.stringify(input); if (commitKey.current.fingerprint !== fingerprint) commitKey.current = { fingerprint, value: requestKey() }; await catalogImportRequest<{ import: Import }>(businessId, `/${record.id}/commit`, { ...input, idempotencyKey: commitKey.current.value }, signal); const stored = await readback(record.id, signal); if (stored.status !== 'committed' || !stored.receipt) throw new Error('readback'); setNotice(stored.receipt.status === 'partial' ? 'Импорт завершён частично. Проверьте список пропущенных строк.' : 'Товары сохранены и проверены.'); onChanged(); })}>{publish ? 'Импортировать и опубликовать' : 'Импортировать черновики'}</button>
                </div>}
                <button className="aw-button" disabled={Boolean(busy)} onClick={() => { setRecord(null); setValidation(null); try { sessionStorage.removeItem(key); } catch { /* optional */ } }}>Выбрать другой файл</button>
            </>}
            {record?.status === 'committed' && record.receipt && <div><h4>{record.receipt.status === 'partial' ? 'Частичный импорт' : 'Импорт завершён'}</h4><p>Добавлено: {record.receipt.added}. Обновлено: {record.receipt.updated}. Пропущено: {record.receipt.skipped.length}. Ошибок: {record.receipt.errors.length}.</p><p>{record.receipt.published ? 'Товары опубликованы и доступны ассистенту.' : 'Товары сохранены черновиками. Опубликуйте нужные позиции в каталоге.'}</p>{record.receipt.errors.length > 0 && <ul>{record.receipt.errors.map(row => <li key={row.row}>Строка {row.row}: {row.messages.join('; ')}</li>)}</ul>}<div className="aw-item-actions"><button className="aw-button" disabled={Boolean(busy)} onClick={() => void run('Проверяем результат…', async signal => { await readback(record.id, signal); onChanged(); })}>Обновить результат</button><button className="aw-button" disabled={Boolean(busy)} onClick={() => { if (!window.confirm('Отменить изменения этого импорта? Новые товары станут неактивными, обновлённые вернутся к прежней версии.')) return; void run('Отменяем импорт…', async signal => { await catalogImportRequest(businessId, `/${record.id}/rollback`, {}, signal); const result = await readback(record.id, signal); if (result.status !== 'rolled_back') throw new Error('readback'); setNotice('Изменения импорта отменены. История предложений сохранена.'); onChanged(); }); }}>Отменить импорт</button><button className="aw-button" disabled={Boolean(busy)} onClick={() => { setRecord(null); setValidation(null); try { sessionStorage.removeItem(key); } catch { /* optional */ } }}>Загрузить ещё</button></div></div>}
        </div>}
    </section>;
}
