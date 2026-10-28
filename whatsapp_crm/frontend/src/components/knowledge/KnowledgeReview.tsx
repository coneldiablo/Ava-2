import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useWorkspaceFeatures } from '../../hooks/useWorkspaceFeatures';
import { useResource } from '../../hooks/useWorkspaceResource';
import { getSessionMembership, hasCapability } from '../../permissions';
import { getKnowledgeReview, createKnowledgeDraft, updateKnowledgeDraft, checkKnowledgeDraft, publishKnowledgeDraft, rollbackKnowledgeDraft, type KnowledgeReviewDraft, type KnowledgeReviewCandidate, type KnowledgeReviewVersion } from '../../improvementsApi';
import { KnowledgeReviewConfirm } from './KnowledgeReviewConfirm';
import { useKnowledgeReviewAction } from './useKnowledgeReviewAction';
import './KnowledgeReview.css';

const statusLabel = (status: string) => ({ draft: 'Черновик', checked: 'Проверен', published: 'Опубликован' }[status] ?? 'Черновик');
const kindLabel = (kind: string) => ({ created: 'Создан', edited: 'Изменён', checked: 'Проверен', published: 'Опубликован', rollback: 'Восстановлен' }[kind] ?? 'Сохранён');
function dateLabel(value: string | null | undefined) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return '';
    return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function KnowledgeReview({ businessId, collapsed = false }: { businessId: number; collapsed?: boolean }) {
    const auth = useAuth();
    const membership = getSessionMembership(auth, businessId);
    const { features } = useWorkspaceFeatures(businessId, auth.userId);
    if (!features?.flags.knowledgeReview || !auth.userId || !membership || !hasCapability({ ...auth, permissionsLoading: false }, businessId, 'sales.read')) return null;
    const panel = <KnowledgeReviewPanel key={`${businessId}:${auth.userId}:${membership.role}:${membership.capabilities?.slice().sort().join(",")}`} businessId={businessId} userId={auth.userId} role={membership.role} disabled={auth.permissionsLoading} canWrite={hasCapability(auth, businessId, 'sales.write')} canGenerate={hasCapability(auth, businessId, 'ai.use')} canApprove={hasCapability(auth, businessId, 'sales.assign')} />;
    return collapsed ? <details className="knowledge-workspace__review"><summary><span>Ответы из обращений</span><small>Черновики, проверка, публикация и история редакций</small></summary>{panel}</details> : panel;
}

function KnowledgeReviewPanel({ businessId, userId, role, disabled, canWrite, canGenerate, canApprove }: { businessId: number; userId: string; role: string; disabled: boolean; canWrite: boolean; canGenerate: boolean; canApprove: boolean }) {
    const titleId = useId();
    const questionId = useId();
    const answerId = useId();
    const proposalId = useId();
    const resource = useResource(`${businessId}:${userId}:knowledge-review`, signal => getKnowledgeReview(businessId, signal));
    const reload = resource.reload;
    const action = useKnowledgeReviewAction();
    const [editor, setEditor] = useState<KnowledgeReviewDraft | null>(null);
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState('');
    const [candidate, setCandidate] = useState<KnowledgeReviewCandidate | null>(null);
    const [proposal, setProposal] = useState('');
    const [confirmation, setConfirmation] = useState<{ action: 'publish' | 'rollback'; target?: KnowledgeReviewVersion } | null>(null);
    const questionField = useRef<HTMLTextAreaElement>(null);
    const latest = useRef({ busy: action.busy });
    const lead = canApprove && (role === 'hotel_owner' || role === 'sales_lead');
    const propose = canWrite && canGenerate && role !== 'observer';
    const dirty = Boolean(editor && (question !== editor.question || answer !== editor.answer));
    latest.current = { busy: action.busy };
    const writable = !disabled && canWrite && role !== 'observer' && (lead || editor?.authorUserId === userId);
    const stale = Boolean(editor && resource.data && resource.data.drafts.find(draft => draft.id === editor.id)?.revision !== editor.revision);
    const blocked = disabled || resource.loading || !resource.data || Boolean(action.busy) || action.uncertain || action.conflict || stale;
    const manual = Boolean(editor?.check?.status === 'manual_required' && editor.check.passed === false && editor.check.needsConfirmation === true && editor.check.version === editor.version && editor.check.revision === editor.revision && editor.status === 'draft' && editor.check.contentHash && editor.check.sourceHash);
    const checked = Boolean(editor?.check?.passed && editor.check.status === 'passed' && editor.check.version === editor.version && editor.check.revision === editor.revision && editor.status === 'checked');
    const publications = editor?.history.filter(version => version.kind === 'published' || version.kind === 'rollback') ?? [];
    const latestPublication = publications.reduce((revision, item) => Math.max(revision, item.revision), -1);
    const restorable = publications.filter(item => item.revision < latestPublication);

    useEffect(() => {
        const refresh = () => { if (document.visibilityState !== 'hidden' && !latest.current.busy) reload(); };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        const timer = window.setInterval(refresh, 60000);
        return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    }, [reload]);

    useEffect(() => { if (!action.busy && action.error) setConfirmation(null); }, [action.busy, action.error]);

    function openDraft(draft: KnowledgeReviewDraft) {
        if (action.busy) return;
        setEditor(draft); setQuestion(draft.question); setAnswer(draft.answer); setCandidate(null); setConfirmation(null); action.clear();
        setTimeout(() => questionField.current?.focus(), 0);
    }
    function applyDraft(response: { draft: KnowledgeReviewDraft }) {
        setEditor(response.draft); setQuestion(response.draft.question); setAnswer(response.draft.answer); setCandidate(null); setConfirmation(null); reload();
    }
    function refresh() { reload(); }
    function reloadEditor() {
        const current = resource.data?.drafts.find(draft => draft.id === editor?.id);
        if (current) openDraft(current);
    }
    function create() {
        if (blocked || !propose || !candidate || !proposal.trim()) return;
        const key = crypto.randomUUID();
        void action.run('create', signal => createKnowledgeDraft(businessId, { question: proposal.trim(), source: candidate.source }, signal, key), applyDraft, 'Черновик подготовлен. Отредактируйте ответ перед проверкой.');
    }
    function save() {
        if (blocked || !editor || !writable || !question.trim() || !answer.trim()) return;
        const key = crypto.randomUUID();
        void action.run('save', signal => updateKnowledgeDraft(businessId, editor.id, { revision: editor.revision, question: question.trim(), answer: answer.trim() }, signal, key), applyDraft, 'Редакция сохранена. Перед публикацией проверьте ответ.');
    }
    function check() {
        if (blocked || !lead || !editor || dirty) return;
        const key = crypto.randomUUID();
        void action.run('check', signal => checkKnowledgeDraft(businessId, editor.id, editor.revision, signal, key), applyDraft, 'Проверка завершена. Ознакомьтесь с результатом.');
    }
    function confirm(attested: boolean) {
        if (blocked || !lead || !editor || !confirmation || dirty) return;
        if (confirmation.action === 'publish' && !checked && !(manual && attested)) return;
        if (confirmation.action === 'rollback' && !restorable.some(item => item.id === confirmation.target?.id)) return;
        const kind = confirmation.action;
        const attestation = manual && editor.check ? { confirm: true as const, revision: editor.check.revision, contentHash: editor.check.contentHash!, sourceHash: editor.check.sourceHash } : undefined;
        const key = crypto.randomUUID();
        void action.run(kind, signal => kind === 'publish'
            ? publishKnowledgeDraft(businessId, editor.id, editor.revision, signal, key, ...(attestation ? [attestation] as const : []))
            : rollbackKnowledgeDraft(businessId, editor.id, editor.revision, confirmation.target!.id, signal, key), applyDraft, kind === 'publish' ? 'Ответ опубликован в базе знаний.' : 'Предыдущая редакция восстановлена.');
    }

    return <section className="knowledge-review" aria-labelledby={titleId}>
        <header className="knowledge-review__header"><div><h2 id={titleId}>Улучшение ответов AVA</h2><p className="knowledge-review__hint">Вопросы клиентов → черновик → проверка → публикация в базе знаний.</p></div><button type="button" className="knowledge-review__button" disabled={resource.loading || Boolean(action.busy)} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />Обновить предложения</button></header>
        {resource.loading && <p role="status">Загружаем предложения…</p>}
        {resource.error && <div className="knowledge-review__feedback knowledge-review__feedback--error" role="alert"><AlertCircle size={17} aria-hidden="true" />Не удалось загрузить предложения. Обновите список и повторите.</div>}
        {disabled && <p className="knowledge-review__hint">Действия доступны после подтверждения доступа к бизнесу.</p>}
        {action.error && <div className="knowledge-review__feedback knowledge-review__feedback--error" role="alert"><AlertCircle size={17} aria-hidden="true" />{action.error}</div>}
        {action.notice && <p className="knowledge-review__feedback" role="status">{action.notice}</p>}
        {!!action.busy && <p role="status">{action.busy === 'create' ? 'Готовим черновик…' : action.busy === 'check' ? 'Проверяем сохранённую редакцию…' : 'Сохраняем изменения…'}</p>}
        {action.uncertain && <button type="button" className="knowledge-review__button" disabled={disabled || Boolean(action.busy) || resource.loading} onClick={() => { void action.retry(); }}>Повторить тот же запрос</button>}
        {(action.busy === 'create' || action.busy === 'check') && <button type="button" className="knowledge-review__button" onClick={action.cancel}>Отменить ожидание</button>}
        {resource.data && <div className="knowledge-review__layout">
            <aside><h3>Сохранённые ответы</h3><div className="knowledge-review__scroll"><ul className="knowledge-review__list">{resource.data.drafts.map(draft => <li key={draft.id}><button type="button" className="knowledge-review__button knowledge-review__item" aria-pressed={editor?.id === draft.id} disabled={Boolean(action.busy) || dirty} onClick={() => openDraft(draft)}><strong>{draft.question}</strong><span className="knowledge-review__badge">{statusLabel(draft.status)} · {dateLabel(draft.updatedAt)}</span></button></li>)}</ul>{!resource.data.drafts.length && <p className="knowledge-review__hint">Пока нет сохранённых предложений.</p>}</div>
                {propose && <><h3 className="mt-5">Вопросы из диалогов</h3><div className="knowledge-review__scroll"><ul className="knowledge-review__list">{resource.data.candidates.map((item, index) => <li key={`${item.source.type}:${item.source.id}`}><button type="button" className="knowledge-review__button knowledge-review__item" aria-label={`Предложить ответ: ${item.text}`} aria-pressed={candidate === item} disabled={blocked || dirty} onClick={() => { setCandidate(item); setProposal(item.text.slice(0, 2000)); setEditor(null); action.clear(); }}><span className="knowledge-review__badge">{item.source.type === 'call' ? 'Звонок клиента' : 'Сообщение клиента'} · {dateLabel(item.createdAt)}</span><strong>{item.text || `Вопрос клиента ${index + 1}`}</strong></button></li>)}</ul>{!resource.data.candidates.length && <p className="knowledge-review__hint">Нет доступных вопросов из диалогов.</p>}</div></>}
            </aside>
            <div>{candidate ? <div className="knowledge-review__editor"><h3>Предложить новый ответ</h3><p className="knowledge-review__hint">Черновик создаётся по выбранному диалогу. Публикацию подтверждает владелец или руководитель.</p><label className="knowledge-review__field" htmlFor={proposalId}>Вопрос для базы знаний<textarea id={proposalId} rows={3} maxLength={2000} value={proposal} disabled={Boolean(action.busy) || action.uncertain} onChange={event => setProposal(event.target.value)} /></label><button type="button" className="knowledge-review__button knowledge-review__button--primary" disabled={blocked || !proposal.trim()} onClick={create}><Sparkles size={16} aria-hidden="true" />Подготовить черновик</button></div> : editor ? <div className="knowledge-review__editor"><h3>{statusLabel(editor.status)}</h3><p className="knowledge-review__hint">Редакция {editor.version}{editor.status === 'published' && editor.sync?.queued ? ' · обновление поиска запланировано' : ''}</p>
                <label className="knowledge-review__field" htmlFor={questionId}>Вопрос<textarea ref={questionField} id={questionId} rows={2} maxLength={2000} value={question} readOnly={!writable} disabled={Boolean(action.busy) || action.uncertain} onChange={event => { setQuestion(event.target.value); setConfirmation(null); }} /></label>
                <label className="knowledge-review__field" htmlFor={answerId}>Ответ<textarea id={answerId} rows={7} maxLength={12000} value={answer} readOnly={!writable} disabled={Boolean(action.busy) || action.uncertain} onChange={event => { setAnswer(event.target.value); setConfirmation(null); }} /></label>
                {dirty && <><p className="knowledge-review__hint" role="status">Есть несохранённые изменения. Сохраните ответ и проверьте новую редакцию.</p><button type="button" className="knowledge-review__button" disabled={Boolean(action.busy)} onClick={() => { setQuestion(editor.question); setAnswer(editor.answer); }}>Отменить изменения</button></>}
                {editor.check && <div className={`knowledge-review__feedback ${!dirty && editor.check.passed ? 'knowledge-review__feedback--success' : ''}`} role="status"><CheckCircle size={17} aria-hidden="true" /><div><strong>{dirty ? 'Проверка относится к сохранённой редакции' : editor.check.passed && editor.check.status === 'passed' ? 'Проверка пройдена' : manual ? 'Нужно подтверждение сведений бизнеса' : 'Ответ требует исправления'}</strong><p>{editor.check.status === 'manual_required' ? 'В документах пока недостаточно подтверждений. Владелец или руководитель может проверить новые сведения и подтвердить их при публикации.' : editor.check.status === 'timeout' ? 'Проверка заняла слишком много времени. Повторите её позже.' : editor.check.status === 'unavailable' ? 'Проверка сейчас недоступна. Повторите её позже.' : editor.check.reason}</p>{!!editor.check.citations.length && <details><summary>Подтверждения в документах</summary>{editor.check.citations.map((citation, index) => <blockquote key={index}>{citation.quote}</blockquote>)}</details>}</div></div>}
                <div className="knowledge-review__actions">{writable && <button type="button" className="knowledge-review__button" disabled={blocked || !dirty || !question.trim() || !answer.trim()} onClick={save}>Сохранить редакцию</button>}{lead && <><button type="button" className="knowledge-review__button" disabled={blocked || dirty || !answer.trim() || editor.status === 'published'} onClick={check}>Проверить ответ</button><button type="button" className="knowledge-review__button knowledge-review__button--primary" disabled={blocked || dirty || (!checked && !manual)} onClick={() => setConfirmation({ action: 'publish' })}>Опубликовать ответ</button></>}{!lead && <p className="knowledge-review__hint">Проверку и публикацию выполняет владелец или руководитель.</p>}</div>
                {(action.conflict || action.uncertain || stale) && <div className="knowledge-review__feedback"><div><p>Перед продолжением сверьте ответ с актуальной сохранённой редакцией. Загрузка заменит текст в редакторе.</p><button type="button" className="knowledge-review__button" disabled={resource.loading || Boolean(action.busy)} onClick={reloadEditor}>Загрузить актуальную редакцию</button></div></div>}
                {editor.approval && <p className="knowledge-review__hint">{editor.approval.type === 'human_confirmed' ? 'Сведения подтверждены владельцем или руководителем.' : 'Ответ подтверждён документами базы знаний.'}</p>}
                {!!editor.history.length && <details className="knowledge-review__history"><summary>История редакций</summary><ul className="knowledge-review__list">{editor.history.map(version => <li key={version.id}><strong>{kindLabel(version.kind)} · редакция {version.version}</strong><p className="knowledge-review__hint">{dateLabel(version.createdAt)}{version.approval?.type === 'human_confirmed' ? ' · сведения подтверждены человеком' : version.approval?.type === 'ai_grounded' ? ' · ответ подтверждён документами' : ''}</p>{restorable.some(item => item.id === version.id) && lead && <><p>{version.answer}</p><button type="button" className="knowledge-review__button" disabled={blocked || dirty} onClick={() => setConfirmation({ action: 'rollback', target: version })}>Восстановить редакцию {version.version}</button></>}</li>)}</ul></details>}
            </div> : <div className="knowledge-review__editor"><h3>Выберите вопрос или черновик</h3><p className="knowledge-review__hint">Проверьте содержание, отредактируйте ответ и сохраните его перед публикацией.</p></div>}</div>
        </div>}
        {confirmation && editor && <KnowledgeReviewConfirm action={confirmation.action} question={confirmation.target?.question ?? editor.question} answer={confirmation.target?.answer ?? editor.answer} requireAttestation={confirmation.action === 'publish' && manual} busy={Boolean(action.busy)} confirmDisabled={blocked || dirty} onConfirm={confirm} onCancel={() => setConfirmation(null)} />}
    </section>;
}
