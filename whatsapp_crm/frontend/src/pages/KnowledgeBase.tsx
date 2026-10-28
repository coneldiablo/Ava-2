import { useState, useEffect, useRef, useCallback } from 'react';
import { BookOpen, Upload, Trash2, Search, FileText, File, AlertCircle, CheckCircle, Loader2, BarChart3, RefreshCw, ChevronDown, ChevronRight, Image, X, TrendingUp, Clock, Hash, Pencil, Save, Ban, Sparkles, ArrowUpRight } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { Link, useLocation } from 'react-router-dom';
import { getKnowledgeBaseFiles, uploadKnowledgeBaseFiles, deleteKnowledgeBaseFile, searchKnowledgeBase, getKnowledgeBaseStats, rebuildKnowledgeBaseEmbeddings, getDocumentChunks, getRAGAnalytics, getUploadStatus, deleteChunk, updateChunk, getDocumentVersions, previewKnowledgeAnswer, getNativeKnowledgeStatus, deleteNativeKnowledgeDocument, type NativeKnowledgeStatus } from '../api';
import './KnowledgePreview.css';
import './KnowledgeBase.css';
import CustomerDocumentEditor from '../components/knowledge/CustomerDocumentEditor';
import KnowledgeReview from '../components/knowledge/KnowledgeReview';

export function customerKnowledgeUploadError(cause: unknown): string {
    const response = (cause as { response?: { status?: number; data?: { results?: { code?: string }[] } } })?.response;
    const codes = Array.isArray(response?.data?.results) ? response.data.results.map(item => item?.code) : [];
    if (codes.includes('KNOWLEDGE_TEXT_EMPTY')) return 'В файле нет текста. Добавьте сведения о бизнесе и повторите загрузку.';
    if (codes.includes('KNOWLEDGE_DOCUMENT_TOO_SHORT')) return 'В документе слишком мало текста. Добавьте сведения или сохраните короткий факт через «Добавить текст».';
    if (response?.status === 413) return 'Файл слишком большой. Загрузите файл размером до 20 МБ.';
    if (response?.status && response.status >= 400 && response.status < 500) return 'Файл не принят. Проверьте его содержимое и формат и повторите загрузку.';
    return 'Загрузка не подтверждена. Обновите список документов и повторите попытку, если файл не появился.';
}

interface KBFile {
    id: number;
    instanceId: number;
    filename: string;
    originalName: string;
    contentHash?: string;
    mimeType?: string;
    fileSize?: number;
    chunkCount?: number;
    hasEmbeddings?: boolean;
    version?: number;
    createdAt: string;
}

interface SearchResult {
    id: number;
    text: string;
    section?: string;
    originalName: string;
    score: number;
    keywordScore?: number;
    vectorScore?: number;
    searchType: string;
    reranked?: boolean;
}

interface ChunkInfo {
    id: number;
    chunkIndex: number;
    text: string;
    section: string | null;
}

interface UploadJob {
    jobId: string;
    originalName: string;
    state: string;
    percent: number;
    stage: string;
    failedReason?: string | null;
    result?: any;
}

interface DocumentVersion {
    id: number;
    version: number;
    createdAt: string;
    isCurrent: number;
    chunkCount?: number;
    hasEmbeddings?: number;
}

interface RAGStats {
    totalDocuments: number;
    totalChunks: number;
    chunksWithEmbeddings: number;
    embeddingsCoverage: number;
    vectorSearchAvailable: boolean;
    embeddingsAvailable: boolean;
    embeddingDimensions?: number;
    searchAnalytics?: {
        totalSearches: number;
        avgResponseTime: number;
        topQueries: { query: string; count: number; avgScore: number }[];
        recentSearches: any[];
        searchesByDay: { date: string; count: number; avgScore: number }[];
    };
}

interface SearchMeta {
    responseTimeMs: number;
    resultsCount: number;
}

type TabType = 'documents' | 'search' | 'analytics';

export default function KnowledgeBase() {
    const { role, userId, memberships } = useAuth();
    const { currentInstanceId } = useInstance();
    const membership = memberships.find(item => item.businessId === currentInstanceId);
    const scope = `${currentInstanceId}:${userId ?? ''}:${membership?.role ?? ''}:${membership?.capabilities?.slice().sort().join(',') ?? ''}`;
    return role === 'platform_admin' ? <AdminKnowledgeBase key={currentInstanceId ?? 'none'} /> : currentInstanceId
        ? <CustomerKnowledgeBase key={scope} businessId={currentInstanceId} />
        : <section className="card p-6 space-y-4"><h1 className="text-2xl font-semibold">База знаний</h1><p>Сначала создайте бизнес, чтобы добавить его документы.</p><Link className="btn-primary inline-flex min-h-[44px] items-center" to="/instances">Выбрать бизнес</Link></section>;
}

function AdminKnowledgeBase() {
    const { currentInstanceId } = useInstance();
    const [files, setFiles] = useState<KBFile[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [searchError, setSearchError] = useState('');
    const searchController = useRef<AbortController | null>(null);
    const [searchType, setSearchType] = useState<'hybrid' | 'vector' | 'keyword'>('hybrid');
    const [stats, setStats] = useState<RAGStats | null>(null);
    const [rebuilding, setRebuilding] = useState(false);
    const [activeTab, setActiveTab] = useState<TabType>('documents');
    const [expandedDoc, setExpandedDoc] = useState<number | null>(null);
    const [chunks, setChunks] = useState<ChunkInfo[]>([]);
    const [loadingChunks, setLoadingChunks] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [analytics, setAnalytics] = useState<any>(null);
    const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
    const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]);
    const [documentVersions, setDocumentVersions] = useState<DocumentVersion[]>([]);
    const [editingChunkId, setEditingChunkId] = useState<number | null>(null);
    const [editingText, setEditingText] = useState('');
    const [editingSection, setEditingSection] = useState('');
    const pollingRef = useRef<number | null>(null);

    useEffect(() => {
        if (currentInstanceId) { loadFiles(); loadStats(); }
    }, [currentInstanceId]);

    useEffect(() => {
        return () => {
            searchController.current?.abort();
            if (pollingRef.current) {
                window.clearInterval(pollingRef.current);
            }
        };
    }, []);

    const loadFiles = async () => {
        if (!currentInstanceId) return;
        setLoading(true);
        try {
            const res = await getKnowledgeBaseFiles(currentInstanceId);
            if (res.success !== true || !Array.isArray(res.files)) throw new Error('Invalid documents');
            setFiles(res.files); setLoadError('');
            if (res.stats) setStats(res.stats);
        } catch (_) { setLoadError('Не удалось загрузить документы. Обновите список и повторите.'); }
        finally { setLoading(false); }
    };

    const loadStats = async () => {
        if (!currentInstanceId) return;
        try { const res = await getKnowledgeBaseStats(currentInstanceId); setStats(res.stats); }
        catch (e) { console.error(e); }
    };

    const loadAnalytics = async () => {
        if (!currentInstanceId) return;
        try { const res = await getRAGAnalytics(currentInstanceId); setAnalytics(res.analytics); }
        catch (e) { console.error(e); }
    };

    const loadDocumentDetails = async (kbId: number, originalName?: string) => {
        if (!currentInstanceId) return;

        const res = await getDocumentChunks(currentInstanceId, kbId);
        setChunks(res.chunks || []);

        if (originalName) {
            const versions = await getDocumentVersions(currentInstanceId, originalName);
            setDocumentVersions(versions.versions || []);
        } else {
            setDocumentVersions([]);
        }
    };

    useEffect(() => {
        if (activeTab === 'analytics' && currentInstanceId) loadAnalytics();
    }, [activeTab, currentInstanceId]);

    const stopPolling = () => {
        if (pollingRef.current) {
            window.clearInterval(pollingRef.current);
            pollingRef.current = null;
        }
    };

    const startPollingJobs = (jobs: UploadJob[]) => {
        if (!currentInstanceId || jobs.length === 0) return;
        stopPolling();
        let activeJobs = jobs;
        setUploadJobs(activeJobs);

        pollingRef.current = window.setInterval(async () => {
            const nextJobs = await Promise.all(activeJobs.map(async (job) => {
                const current = activeJobs.find(existing => existing.jobId === job.jobId) || job;
                if (['completed', 'failed'].includes(current.state)) {
                    return current;
                }

                try {
                    const status = await getUploadStatus(currentInstanceId, job.jobId);
                    return {
                        ...current,
                        state: status.state,
                        percent: status.percent ?? 0,
                        stage: status.stage || 'queued',
                        failedReason: status.failedReason,
                        result: status.result
                    };
                } catch (error: any) {
                    return {
                        ...current,
                        state: current.state === 'completed' ? 'completed' : 'failed',
                        percent: current.percent,
                        stage: current.stage,
                        failedReason: error.response?.data?.error || 'Не удалось получить статус загрузки'
                    };
                }
            }));

            activeJobs = nextJobs;
            setUploadJobs(nextJobs);

            if (nextJobs.every(job => ['completed', 'failed'].includes(job.state))) {
                stopPolling();
                await loadFiles();
                await loadStats();

                const successCount = nextJobs.filter(job => job.state === 'completed' && job.result?.success).length;
                const duplicateCount = nextJobs.filter(job => job.result?.isDuplicate).length;
                const failCount = nextJobs.filter(job => job.state === 'failed' || (job.state === 'completed' && !job.result?.success && !job.result?.isDuplicate)).length;

                if (failCount === 0) {
                    setUploadResult({
                        type: duplicateCount > 0 ? 'error' : 'success',
                        message: duplicateCount > 0
                            ? `Завершено: ${successCount} обработано, ${duplicateCount} дубликат(ов).`
                            : `Завершено: ${successCount} файл(ов) обработано.`
                    });
                } else {
                    setUploadResult({
                        type: 'error',
                        message: `Завершено с ошибками: ${successCount} успешно, ${duplicateCount} дубликат(ов), ${failCount} ошибка(ок).`
                    });
                }
            }
        }, 1500);
    };

    const handleUpload = async (fileList: File[]) => {
        if (!currentInstanceId || fileList.length === 0) return;
        const allowedTypes = ['application/pdf','text/plain','text/csv','text/markdown','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg'];
        const validFiles = fileList.filter(f => {
            if (!allowedTypes.includes(f.type)) { setUploadResult({ type: 'error', message: `Неподдерживаемый формат: ${f.name}` }); return false; }
            if (f.size > 20 * 1024 * 1024) { setUploadResult({ type: 'error', message: `${f.name} слишком большой (макс 20 МБ)` }); return false; }
            return true;
        });
        if (validFiles.length === 0) return;
        setUploading(true); setUploadResult(null);
        try {
            const res = await uploadKnowledgeBaseFiles(currentInstanceId, validFiles);
            const results = res.results || [res];
            const queued = results.filter((r: any) => r.queued && r.jobId);
            const immediate = results.filter((r: any) => !r.queued);

            const ok = immediate.filter((r: any) => r.success).length;
            const fail = immediate.filter((r: any) => !r.success).length;
            const duplicate = immediate.filter((r: any) => r.isDuplicate).length;

            if (queued.length > 0) {
                startPollingJobs(queued.map((job: any) => ({
                    jobId: String(job.jobId),
                    originalName: job.originalName,
                    state: 'queued',
                    percent: 0,
                    stage: 'queued'
                })));

                setUploadResult({
                    type: 'success',
                    message: `Файлы поставлены в очередь: ${queued.length}. ${ok > 0 ? `Мгновенно обработано: ${ok}. ` : ''}${fail > 0 || duplicate > 0 ? `Ошибок/дубликатов: ${fail + duplicate}.` : ''}`.trim()
                });
            } else {
                setUploadResult({
                    type: fail === 0 && duplicate === 0 ? 'success' : 'error',
                    message: fail === 0 && duplicate === 0
                        ? `Загружено ${ok} файл(ов)!`
                        : `${ok} успешно, ${duplicate} дубликат(ов), ${fail} ошибка(ок).`
                });
            }

            await loadFiles();
            await loadStats();
        } catch (e: any) {
            if (e.response?.status === 409) setUploadResult({ type: 'error', message: 'Дубликат отклонён.' });
            else setUploadResult({ type: 'error', message: e.response?.data?.error || 'Ошибка загрузки' });
        } finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
    };

    const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files) handleUpload(Array.from(e.target.files)); };
    const onDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(false); handleUpload(Array.from(e.dataTransfer.files)); }, [currentInstanceId]);
    const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true); }, []);
    const onDragLeave = useCallback(() => { setDragOver(false); }, []);

    const handleDelete = async (fileId: number, name: string) => {
        if (!currentInstanceId || !confirm(`Удалить "${name}"?`)) return;
        try {
            await deleteKnowledgeBaseFile(currentInstanceId, fileId);
            if (expandedDoc === fileId) {
                setExpandedDoc(null);
                setChunks([]);
                setDocumentVersions([]);
            }
            await loadFiles();
            await loadStats();
        }
        catch (e: any) { alert('Ошибка: ' + (e.response?.data?.error || e.message)); }
    };

    const resetSearch = () => {
        searchController.current?.abort();
        searchController.current = null;
        setSearching(false);
        setSearched(false);
        setSearchError('');
        setSearchResults([]);
        setSearchMeta(null);
    };

    const handleSearch = async () => {
        if (!currentInstanceId || !searchQuery.trim() || searchController.current) return;
        const controller = new AbortController();
        searchController.current = controller;
        setSearching(true);
        setSearched(false);
        setSearchError('');
        setSearchResults([]);
        setSearchMeta(null);
        try {
            const res = await searchKnowledgeBase(currentInstanceId, searchQuery.trim(), searchType, 5, controller.signal);
            if (controller.signal.aborted) return;
            if (res.success !== true || !Array.isArray(res.results)) throw new Error('Invalid search response');
            setSearchResults(res.results || []);
            setSearchMeta({
                responseTimeMs: res.responseTimeMs ?? 0,
                resultsCount: res.resultsCount ?? res.results.length
            });
            setSearched(true);
        }
        catch (e) { if (!controller.signal.aborted) setSearchError('Не удалось выполнить поиск. Проверьте соединение и повторите.'); }
        finally { if (!controller.signal.aborted) { searchController.current = null; setSearching(false); } }
    };

    const handleRebuild = async () => {
        if (!currentInstanceId || !confirm('Пересоздать недостающие эмбеддинги?')) return;
        setRebuilding(true);
        try { const res = await rebuildKnowledgeBaseEmbeddings(currentInstanceId); if (res.success) { alert(`Готово! ${res.rebuilt} эмбеддингов`); await loadStats(); } else alert('Ошибка: ' + res.error); }
        catch (e: any) { alert('Ошибка: ' + (e.response?.data?.error || e.message)); }
        finally { setRebuilding(false); }
    };

    const toggleChunks = async (kbId: number) => {
        if (expandedDoc === kbId) { setExpandedDoc(null); setChunks([]); setDocumentVersions([]); setEditingChunkId(null); return; }
        if (!currentInstanceId) return;
        setExpandedDoc(kbId); setLoadingChunks(true);
        try {
            const file = files.find(entry => entry.id === kbId);
            await loadDocumentDetails(kbId, file?.originalName);
        }
        catch (e) { console.error(e); }
        finally { setLoadingChunks(false); }
    };

    const handleStartEditChunk = (chunk: ChunkInfo) => {
        setEditingChunkId(chunk.id);
        setEditingText(chunk.text);
        setEditingSection(chunk.section || '');
    };

    const handleSaveChunk = async (chunkId: number) => {
        if (!currentInstanceId) return;
        try {
            await updateChunk(currentInstanceId, chunkId, editingText, editingSection || undefined);
            setEditingChunkId(null);
            if (expandedDoc) {
                const file = files.find(entry => entry.id === expandedDoc);
                await loadDocumentDetails(expandedDoc, file?.originalName);
            }
            await loadFiles();
            await loadStats();
        } catch (e: any) {
            alert('Ошибка: ' + (e.response?.data?.error || e.message));
        }
    };

    const handleDeleteChunk = async (chunkId: number) => {
        if (!currentInstanceId || !confirm('Удалить этот фрагмент?')) return;
        try {
            await deleteChunk(currentInstanceId, chunkId);
            if (editingChunkId === chunkId) {
                setEditingChunkId(null);
            }
            if (expandedDoc) {
                const file = files.find(entry => entry.id === expandedDoc);
                await loadDocumentDetails(expandedDoc, file?.originalName);
            }
            await loadFiles();
            await loadStats();
        } catch (e: any) {
            alert('Ошибка: ' + (e.response?.data?.error || e.message));
        }
    };

    const fmtSize = (b?: number) => { if (!b) return ''; if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b/1024).toFixed(1)} KB`; return `${(b/1048576).toFixed(1)} MB`; };

    const tabs: { key: TabType; label: string; Icon: any }[] = [
        { key: 'documents', label: 'Документы', Icon: FileText },
        { key: 'search', label: 'Поиск', Icon: Search },
        { key: 'analytics', label: 'Аналитика', Icon: BarChart3 },
    ];

    return (
        <div className="max-w-5xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-neu-text flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-accent-2/15 flex items-center justify-center shadow-neu-raised-sm"><BookOpen size={20} className="text-accent-2" /></div>
                        База знаний (RAG)
                    </h1>
                    <p className="text-neu-muted text-sm mt-1">PDF, DOCX, TXT, изображения — AI отвечает на основе ваших данных.</p>
                </div>
                {stats && (
                    <button onClick={handleRebuild} disabled={rebuilding} className="btn-secondary px-4 py-2 flex items-center gap-2">
                        {rebuilding ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                        <span className="text-sm">{stats.embeddingsCoverage}% ({stats.chunksWithEmbeddings}/{stats.totalChunks})</span>
                    </button>
                )}
            </div>

            {/* Stats */}
            {stats && (
                <div className="card" style={{ background: 'linear-gradient(135deg, rgba(108,92,231,0.08), rgba(0,194,255,0.08))' }}>
                    <div className="card-body">
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                            {[
                                { v: stats.totalDocuments, l: 'Документов', c: 'text-accent-2' },
                                { v: stats.totalChunks, l: 'Фрагментов', c: 'text-accent' },
                                { v: stats.chunksWithEmbeddings, l: 'С эмбеддингами', c: 'text-green-400' },
                                { v: stats.vectorSearchAvailable ? '✓' : '✗', l: 'Векторный поиск', c: 'text-purple-400' },
                                { v: stats.embeddingDimensions || '?', l: 'Размерность', c: 'text-cyan-400' },
                            ].map((s, i) => (
                                <div key={i} className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm">
                                    <div className={`text-2xl font-bold ${s.c}`}>{s.v}</div>
                                    <div className="text-neu-muted text-xs">{s.l}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Upload - Drag and Drop */}
            <div className="card">
                <div className="card-header"><Upload size={18} className="text-accent-2" /><h2 className="font-semibold text-neu-text">Загрузить документы</h2></div>
                <div className="card-body">
                    <div className={`rounded-xl p-8 text-center transition-all duration-300 ${dragOver ? 'shadow-accent-glow' : 'neu-inset'}`}
                         style={{ border: `2px dashed ${dragOver ? 'rgba(108,92,231,0.5)' : 'rgba(255,255,255,0.06)'}` }}
                         onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}>
                        <input ref={fileInputRef} type="file" accept=".pdf,.txt,.csv,.md,.docx,.png,.jpg,.jpeg" onChange={onFileInput} className="hidden" id="kb-upload" multiple />
                        <label htmlFor="kb-upload" className="cursor-pointer flex flex-col items-center gap-3">
                            {uploading ? (
                                <><Loader2 size={40} className="text-accent-2 animate-spin" /><span className="text-neu-muted">Обрабатываем...</span></>
                            ) : (
                                <>
                                    <div className="w-14 h-14 rounded-2xl bg-accent-2/10 flex items-center justify-center shadow-neu-raised-sm"><FileText size={28} className="text-accent-2" /></div>
                                    <div>
                                        <span className="text-neu-text font-medium block">Перетащите файлы или нажмите для выбора</span>
                                        <span className="text-neu-muted text-xs mt-1 block">PDF, DOCX, TXT, PNG, JPEG. Макс 20 МБ. Можно несколько файлов.</span>
                                    </div>
                                </>
                            )}
                        </label>
                    </div>
                    {loadError && <p role="alert" className="text-red-400">{loadError}</p>}
                    {uploadResult && (
                        <div className={`mt-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm shadow-neu-raised-sm ${uploadResult.type === 'success' ? 'text-green-400' : 'text-red-400'}`}
                             style={{ background: uploadResult.type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)' }}>
                            {uploadResult.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                            {uploadResult.message}
                            <button onClick={() => setUploadResult(null)} className="ml-auto p-1 rounded hover:bg-white/5"><X size={14} /></button>
                        </div>
                    )}
                    {uploadJobs.length > 0 && (
                        <div className="mt-4 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold uppercase tracking-wider text-neu-muted">Очередь загрузки</span>
                                {uploadJobs.every(job => ['completed', 'failed'].includes(job.state)) && (
                                    <button onClick={() => setUploadJobs([])} className="text-xs text-neu-muted hover:text-neu-text">
                                        Очистить
                                    </button>
                                )}
                            </div>
                            {uploadJobs.map(job => {
                                const terminalSuccess = job.state === 'completed' && job.result?.success && !job.result?.isDuplicate;
                                const terminalDuplicate = job.result?.isDuplicate;
                                const terminalFailure = job.state === 'failed' || (job.state === 'completed' && !job.result?.success && !terminalDuplicate);
                                const progressColor = terminalSuccess
                                    ? 'bg-green-500'
                                    : terminalDuplicate
                                        ? 'bg-yellow-500'
                                        : terminalFailure
                                            ? 'bg-red-500'
                                            : 'bg-accent-2';

                                return (
                                    <div key={job.jobId} className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm space-y-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-sm text-neu-text font-medium truncate">{job.originalName}</div>
                                                <div className="text-xs text-neu-muted">
                                                    {job.stage || job.state}
                                                    {job.percent > 0 ? ` • ${job.percent}%` : ''}
                                                </div>
                                            </div>
                                            <div className={`text-xs px-2 py-1 rounded-lg ${
                                                terminalSuccess ? 'bg-green-500/10 text-green-400'
                                                    : terminalDuplicate ? 'bg-yellow-500/10 text-yellow-400'
                                                    : terminalFailure ? 'bg-red-500/10 text-red-400'
                                                    : 'bg-accent-2/10 text-accent-2'
                                            }`}>
                                                {terminalSuccess ? 'Готово' : terminalDuplicate ? 'Дубликат' : terminalFailure ? 'Ошибка' : 'В очереди'}
                                            </div>
                                        </div>
                                        <div className="h-2 rounded-full bg-neu-surface-2 overflow-hidden">
                                            <div
                                                className={`h-full rounded-full transition-all duration-300 ${progressColor}`}
                                                style={{ width: `${Math.max(job.percent || 0, terminalSuccess || terminalDuplicate || terminalFailure ? 100 : 6)}%` }}
                                            />
                                        </div>
                                        {(job.failedReason || job.result?.error || terminalDuplicate) && (
                                            <div className={`text-xs ${terminalFailure ? 'text-red-400' : 'text-yellow-400'}`}>
                                                {job.failedReason || job.result?.error || 'Файл уже существует для этого instanceId'}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Tabs */}
            <div className="flex flex-wrap gap-2 border-b border-neu-surface-2 pb-0">
                {tabs.map(t => (
                    <button key={t.key} onClick={() => setActiveTab(t.key)}
                        className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-all border-b-2 ${activeTab === t.key ? 'text-accent-2 border-accent-2' : 'text-neu-muted border-transparent hover:text-neu-text'}`}>
                        <t.Icon size={16} /> {t.label}
                    </button>
                ))}
            </div>

            {/* Documents Tab */}
            {activeTab === 'documents' && (
                <div className="card">
                    <div className="card-header"><File size={18} className="text-accent" /><h2 className="font-semibold text-neu-text">Документы</h2><span className="text-xs text-neu-muted ml-2">({files.length})</span></div>
                    <div className="card-body">
                        {loading ? <div className="flex items-center justify-center py-8"><Loader2 size={24} className="text-accent-2 animate-spin" /></div>
                        : loadError ? <button type="button" className="btn-secondary" onClick={() => void loadFiles()}>Повторить загрузку документов</button> : files.length === 0 ? <div className="text-center py-8 text-neu-muted"><FileText size={40} className="mx-auto mb-3 opacity-30" /><p>Документы ещё не загружены.</p></div>
                        : (
                            <div className="space-y-2">
                                {files.map(file => (
                                    <div key={file.id}>
                                        <div className="flex items-center justify-between p-3 rounded-xl bg-neu-surface-2 shadow-neu-raised-sm hover:shadow-neu-hover transition-all group">
                                            <button type="button" className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-expanded={expandedDoc === file.id} onClick={() => toggleChunks(file.id)}>
                                                {expandedDoc === file.id ? <ChevronDown size={16} className="text-neu-muted shrink-0" /> : <ChevronRight size={16} className="text-neu-muted shrink-0" />}
                                                <span className="w-10 h-10 rounded-xl bg-accent-2/10 flex items-center justify-center shadow-neu-inset-sm shrink-0">
                                                    {file.originalName.endsWith('.pdf') ? <FileText size={18} className="text-red-400" />
                                                    : file.originalName.endsWith('.docx') ? <FileText size={18} className="text-blue-400" />
                                                    : file.originalName.match(/\.(png|jpe?g)$/) ? <Image size={18} className="text-purple-400" />
                                                    : <File size={18} className="text-accent" />}
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="text-neu-text text-sm font-medium block truncate">{file.originalName}</span>
                                                    <span className="text-neu-muted text-xs">
                                                        {new Date(file.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
                                                        {file.chunkCount ? ` • ${file.chunkCount} фрагм.` : ''}
                                                        {file.version && file.version > 1 ? ` • v${file.version}` : ''}
                                                        {file.fileSize ? ` • ${fmtSize(file.fileSize)}` : ''}
                                                    </span>
                                                </span>
                                            </button>
                                            <div className="flex items-center gap-2">
                                                {file.hasEmbeddings && <div className="px-2 py-1 rounded-lg bg-green-500/10 text-green-400 text-xs">✓ Вектор</div>}
                                                <button type="button" aria-label={`Удалить документ ${file.originalName}`} onClick={() => handleDelete(file.id, file.originalName)} className="min-h-11 min-w-11 p-2 rounded-xl text-red-400 hover:bg-red-500/10 transition-colors"><Trash2 size={16} aria-hidden="true" /></button>
                                            </div>
                                        </div>
                                        {/* Chunk Inspector */}
                                        {expandedDoc === file.id && (
                                            <div className="ml-6 mt-2 space-y-3">
                                                <div className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm">
                                                    <div className="text-xs font-semibold uppercase tracking-wider text-neu-muted mb-2">История версий</div>
                                                    {documentVersions.length === 0 ? (
                                                        <div className="text-xs text-neu-muted">Для этого документа пока нет сохраненной истории версий.</div>
                                                    ) : (
                                                        <div className="flex flex-wrap gap-2">
                                                            {documentVersions.map(version => (
                                                                <div
                                                                    key={version.id}
                                                                    className={`px-3 py-2 rounded-xl text-xs shadow-neu-inset-sm ${
                                                                        version.isCurrent
                                                                            ? 'bg-accent-2/10 text-accent-2'
                                                                            : 'bg-neu-surface-2 text-neu-muted'
                                                                    }`}
                                                                >
                                                                    <div className="font-semibold">v{version.version}</div>
                                                                    <div>{new Date(version.createdAt).toLocaleDateString('ru-RU')}</div>
                                                                    <div>{version.chunkCount || 0} фрагм.</div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                                {loadingChunks ? <div className="p-3 text-center"><Loader2 size={16} className="text-accent-2 animate-spin" /></div>
                                                : chunks.length === 0 ? <div className="p-3 text-neu-muted text-xs">Нет фрагментов</div>
                                                : chunks.map(chunk => (
                                                    <div key={chunk.id} className="p-3 rounded-lg bg-neu-surface-1 shadow-neu-inset-sm space-y-3">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <Hash size={12} className="text-neu-muted" />
                                                                <span className="text-xs text-neu-muted">#{chunk.chunkIndex}</span>
                                                                {(editingChunkId === chunk.id ? editingSection : chunk.section) && (
                                                                    <span className="text-xs text-accent-2 bg-accent-2/10 px-2 py-0.5 rounded">
                                                                        {editingChunkId === chunk.id ? editingSection : chunk.section}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2 shrink-0">
                                                                {editingChunkId === chunk.id ? (
                                                                    <>
                                                                        <button onClick={() => handleSaveChunk(chunk.id)} className="p-2 rounded-lg text-green-400 hover:bg-green-500/10" title="Сохранить">
                                                                            <Save size={15} />
                                                                        </button>
                                                                        <button onClick={() => setEditingChunkId(null)} className="p-2 rounded-lg text-neu-muted hover:bg-neu-surface-2" title="Отменить">
                                                                            <Ban size={15} />
                                                                        </button>
                                                                    </>
                                                                ) : (
                                                                    <button onClick={() => handleStartEditChunk(chunk)} className="p-2 rounded-lg text-accent-2 hover:bg-accent-2/10" title="Редактировать">
                                                                        <Pencil size={15} />
                                                                    </button>
                                                                )}
                                                                <button onClick={() => handleDeleteChunk(chunk.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-500/10" title="Удалить">
                                                                    <Trash2 size={15} />
                                                                </button>
                                                            </div>
                                                        </div>
                                                        {editingChunkId === chunk.id ? (
                                                            <div className="space-y-2">
                                                                <input
                                                                    type="text"
                                                                    value={editingSection}
                                                                    onChange={e => setEditingSection(e.target.value)}
                                                                    placeholder="Секция"
                                                                    className="input w-full"
                                                                />
                                                                <textarea
                                                                    value={editingText}
                                                                    onChange={e => setEditingText(e.target.value)}
                                                                    rows={6}
                                                                    className="input w-full resize-y"
                                                                />
                                                            </div>
                                                        ) : (
                                                            <pre className="text-neu-text text-xs whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto">{chunk.text}</pre>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Search Tab */}
            {activeTab === 'search' && (
                <div className="card">
                    <div className="card-header"><Search size={18} className="text-green-400" /><h2 className="font-semibold text-neu-text">Тестовый поиск</h2></div>
                    <div className="card-body">
                        <div className="flex gap-2 mb-3">
                            {(['hybrid','vector','keyword'] as const).map(t => (
                                <button key={t} type="button" onClick={() => { resetSearch(); setSearchType(t); }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${searchType === t ? 'bg-accent-2 text-white shadow-neu-raised-sm' : 'bg-neu-surface-1 text-neu-muted hover:bg-neu-surface-2'}`}>
                                    {t === 'hybrid' ? '🎯 Гибридный' : t === 'vector' ? '🔮 Векторный' : '🔑 Ключевые слова'}
                                </button>
                            ))}
                        </div>
                        <form className="flex gap-3" onSubmit={event => { event.preventDefault(); void handleSearch(); }}>
                            <label className="sr-only" htmlFor="admin-knowledge-query">Запрос по документам</label>
                            <input id="admin-knowledge-query" type="search" value={searchQuery} onChange={e => { resetSearch(); setSearchQuery(e.target.value); }} placeholder="сколько стоит доставка?" className="flex-1 input" />
                            <button type="submit" disabled={searching || !searchQuery.trim() || !currentInstanceId} className="btn-primary px-5">
                                {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Найти
                            </button>
                        </form>
                        {!currentInstanceId && <p className="mt-3 text-sm text-neu-muted">Выберите бизнес для поиска.</p>}
                        {searchError && <p role="alert" className="mt-3 text-sm text-red-400">{searchError}</p>}
                        {searchMeta && (
                            <div className="mt-3 flex items-center gap-3 text-xs text-neu-muted">
                                <span>Ответ за {searchMeta.responseTimeMs} мс</span>
                                <span>Найдено: {searchMeta.resultsCount}</span>
                            </div>
                        )}
                        {searchResults.length > 0 && (
                            <div className="mt-4 space-y-3">
                                <p className="text-xs text-neu-muted font-semibold uppercase tracking-wider">Результатов: {searchResults.length}</p>
                                {searchResults.map(r => (
                                    <div key={r.id} className="p-4 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm border-l-4 border-accent-2">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-accent-2">{r.originalName}</span>
                                                {r.section && <span className="text-xs text-neu-muted bg-neu-surface-2 px-2 py-0.5 rounded">{r.section}</span>}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {r.reranked && <span className="text-xs text-purple-400">reranked</span>}
                                                <span className="text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-400">{Math.round(r.score * 100)}%</span>
                                            </div>
                                        </div>
                                        <pre className="text-neu-text text-sm whitespace-pre-wrap font-sans leading-relaxed">{r.text}</pre>
                                    </div>
                                ))}
                            </div>
                        )}
                        {searching && <div className="mt-4 flex items-center justify-center py-8"><Loader2 size={24} className="text-accent-2 animate-spin" /></div>}
                        {searched && searchResults.length === 0 && <div className="mt-4 text-center py-8 text-neu-muted" role="status"><Search size={40} className="mx-auto mb-3 opacity-30" /><p>Ничего не найдено.</p></div>}
                    </div>
                </div>
            )}

            {/* Analytics Tab */}
            {activeTab === 'analytics' && (
                <div className="card">
                    <div className="card-header"><TrendingUp size={18} className="text-yellow-400" /><h2 className="font-semibold text-neu-text">Аналитика поиска</h2></div>
                    <div className="card-body">
                        {!analytics ? <div className="text-center py-8"><Loader2 size={24} className="text-accent-2 animate-spin" /></div> : (
                            <div className="space-y-6">
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                    <div className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm">
                                        <div className="text-2xl font-bold text-accent-2">{analytics.totalSearches || 0}</div>
                                        <div className="text-neu-muted text-xs">Всего запросов</div>
                                    </div>
                                    <div className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm">
                                        <div className="text-2xl font-bold text-accent">{analytics.avgResponseTime || 0}мс</div>
                                        <div className="text-neu-muted text-xs">Среднее время</div>
                                    </div>
                                    <div className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm">
                                        <div className="text-2xl font-bold text-green-400">{analytics.searchesByDay?.length || 0}</div>
                                        <div className="text-neu-muted text-xs">Дней активности</div>
                                    </div>
                                    <div className="p-3 rounded-xl bg-neu-surface-1 shadow-neu-raised-sm">
                                        <div className="text-2xl font-bold text-purple-400">{analytics.aiUseRate || 0}%</div>
                                        <div className="text-neu-muted text-xs">AI-use rate</div>
                                    </div>
                                </div>
                                {analytics.topQueries?.length > 0 && (
                                    <div>
                                        <h3 className="text-neu-text font-semibold text-sm mb-2">Популярные запросы</h3>
                                        <div className="space-y-1">
                                            {analytics.topQueries.map((q: any, i: number) => (
                                                <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-neu-surface-1 shadow-neu-inset-sm">
                                                    <span className="text-neu-text text-sm truncate">{q.query}</span>
                                                    <div className="flex items-center gap-3 shrink-0">
                                                        <span className="text-xs text-neu-muted">{q.count}x</span>
                                                        <span className="text-xs text-green-400">{Math.round((q.avgScore || 0) * 100)}%</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {analytics.recentSearches?.length > 0 && (
                                    <div>
                                        <h3 className="text-neu-text font-semibold text-sm mb-2">Последние запросы</h3>
                                        <div className="space-y-1">
                                            {analytics.recentSearches.slice(0, 10).map((s: any, i: number) => (
                                                <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-neu-surface-1 shadow-neu-inset-sm">
                                                    <span className="text-neu-text text-sm truncate flex-1 min-w-0">{s.query}</span>
                                                    <div className="flex items-center gap-2 shrink-0 text-xs">
                                                        <span className="text-neu-muted"><Clock size={10} className="inline" /> {s.responseTimeMs}мс</span>
                                                        <span className="text-green-400">{Math.round((s.topScore || 0) * 100)}%</span>
                                                        <span className={`px-1.5 py-0.5 rounded ${s.wasUsedByAI ? 'bg-purple-500/10 text-purple-400' : 'bg-neu-surface-2 text-neu-muted'}`}>{s.wasUsedByAI ? 'AI' : 'UI'}</span>
                                                        <span className={`px-1.5 py-0.5 rounded ${s.searchType === 'hybrid' ? 'bg-accent-2/10 text-accent-2' : s.searchType === 'vector' ? 'bg-purple-500/10 text-purple-400' : 'bg-accent/10 text-accent'}`}>{s.searchType}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {analytics.totalSearches === 0 && (
                                    <div className="text-center py-8 text-neu-muted">
                                        <BarChart3 size={40} className="mx-auto mb-3 opacity-30" />
                                        <p>Пока нет данных аналитики.</p>
                                        <p className="text-xs mt-1">Аналитика появится после первых поисковых запросов.</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* How it works */}
            <div className="card" style={{ background: 'linear-gradient(135deg, rgba(108,92,231,0.05), rgba(0,194,255,0.05))' }}>
                <div className="card-body">
                    <h3 className="text-neu-text font-semibold mb-3">Как это работает</h3>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                        {[
                            { n: '1', c: 'bg-accent-2/10 text-accent-2', t: 'Загрузите документ', d: 'PDF, DOCX, TXT, изображения' },
                            { n: '2', c: 'bg-accent/10 text-accent', t: 'AI разбивает на части', d: 'Семантическое чанкование по предложениям' },
                            { n: '3', c: 'bg-green-500/10 text-green-400', t: 'Векторный + FTS5 поиск', d: 'GigaChat эмбеддинги + Cohere rerank' },
                            { n: '4', c: 'bg-purple-500/10 text-purple-400', t: 'Точные ответы', d: 'AI отвечает на основе ваших данных' },
                        ].map((s, i) => (
                            <div key={i} className="flex gap-3">
                                <div className={`w-8 h-8 rounded-xl ${s.c} flex items-center justify-center shrink-0 font-bold shadow-neu-raised-sm`}>{s.n}</div>
                                <div><span className="text-neu-text font-medium block">{s.t}</span><span className="text-neu-muted text-xs">{s.d}</span></div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

type CustomerFile = { id: number; originalName: string; fileSize?: number; createdAt?: string; chunkCount?: number };
type CustomerJob = { name: string; jobId: string; state: string; percent: number };
type PreviewCitation = { sourceId: string | number; title: string };
type PreviewResult = { question: string; answer: string; citations: PreviewCitation[]; sourceTimestamp?: string; correlationId?: string };

function CustomerKnowledgeBase({ businessId }: { businessId: number }) {
    const { hash } = useLocation();
    const [editingDocument, setEditingDocument] = useState<number | null>(null);
    const { currentInstance } = useInstance();
    const { memberships, permissionsLoading } = useAuth();
    const owner = !permissionsLoading && memberships.some(item => item.businessId === businessId && item.role === 'hotel_owner');
    const [files, setFiles] = useState<CustomerFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [nativeStatus, setNativeStatus] = useState<NativeKnowledgeStatus | null>(null);
    const [nativeError, setNativeError] = useState('');
    const [statusRevision, setStatusRevision] = useState(0);
    const filesController = useRef<AbortController | null>(null);
    const uploadController = useRef<AbortController | null>(null);
    const jobsController = useRef<AbortController | null>(null);
    const uploadBusy = useRef(false);
    const deleteController = useRef<AbortController | null>(null);
    const [uploading, setUploading] = useState(false);
    const [jobs, setJobs] = useState<CustomerJob[]>([]);
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const [textTitle, setTextTitle] = useState('');
    const [textBody, setTextBody] = useState('');
    const [previewQuestion, setPreviewQuestion] = useState('');
    const [preview, setPreview] = useState<PreviewResult | null>(null);
    const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'error' | 'not-ready' | 'ungrounded'>('idle');
    const [previewError, setPreviewError] = useState('');
    const previewController = useRef<AbortController | null>(null);
    const previewSequence = useRef(0);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const active = useRef(true);
    const uploadInput = useRef<HTMLInputElement>(null);

    const refresh = useCallback(async () => {
        filesController.current?.abort();
        const controller = new AbortController();
        filesController.current = controller;
        setLoading(true);
        try {
            const response = await getKnowledgeBaseFiles(businessId, controller.signal);
            if (response.success !== true || !Array.isArray(response.files)) throw new Error();
            if (active.current && !controller.signal.aborted) { setFiles(response.files); setLoadError(''); setStatusRevision(value => value + 1); }
        } catch (_) {
            if (active.current && !controller.signal.aborted) setLoadError('Не удалось загрузить документы. Проверьте соединение и повторите.');
        } finally { if (active.current && !controller.signal.aborted) setLoading(false); }
    }, [businessId]);

    useEffect(() => {
        active.current = true;
        void refresh();
        return () => { active.current = false; filesController.current?.abort(); uploadController.current?.abort(); deleteController.current?.abort(); jobsController.current?.abort(); previewSequence.current += 1; previewController.current?.abort(); if (timer.current) clearTimeout(timer.current); };
    }, [refresh]);

    useEffect(() => {
        const controller = new AbortController();
        let statusTimer: ReturnType<typeof setTimeout>;
        async function poll() {
            try {
                const response = await getNativeKnowledgeStatus(businessId, controller.signal);
                if (response.success !== true || response.businessId !== businessId || !Array.isArray(response.documents)) throw new Error();
                if (!controller.signal.aborted) { setNativeStatus(response); setNativeError(''); }
            } catch (_) {
                if (!controller.signal.aborted) { setNativeStatus(null); setNativeError('Не удалось проверить обработку документов для ответов AVA.'); }
            } finally {
                if (!controller.signal.aborted) statusTimer = setTimeout(() => void poll(), 10000);
            }
        }
        void poll();
        return () => { controller.abort(); clearTimeout(statusTimer); };
    }, [businessId, statusRevision]);

    const documentState = (id: number) => {
        if (nativeError) return 'Статус поиска недоступен';
        if (!nativeStatus) return 'Проверяем обработку';
        const state = nativeStatus.documents.find(item => item.id === id)?.state;
        return ({ submitted: 'Передан в поиск', processing: 'Готовим для ответов', needs_sync: 'Ожидает обработки',
            failed: 'Не удалось подготовить для ответов', empty: 'Нет текста для поиска', unavailable: 'Поиск пока недоступен' } as Record<string, string>)[state || ''] || 'Проверяем обработку';
    };

    async function runPreview(event?: React.FormEvent) {
        event?.preventDefault();
        const question = previewQuestion.trim();
        if (!question || previewController.current || permissionsLoading) return;
        const controller = new AbortController();
        previewController.current = controller;
        const sequence = ++previewSequence.current;
        setPreviewError(''); setPreviewState('loading');
        try {
            const response = await previewKnowledgeAnswer(businessId, question, controller.signal);
            if (!active.current || controller.signal.aborted || sequence !== previewSequence.current) return;
            if (response.success && response.businessId === businessId
                && typeof response.answer === 'string' && response.answer.trim()
                && Array.isArray(response.citations) && response.citations.length > 0
                && response.citations.every((citation: PreviewCitation) => citation && Number.isSafeInteger(citation.sourceId)
                    && Number(citation.sourceId) > 0 && typeof citation.title === 'string' && !!citation.title.trim())) {
                setPreview({ question, answer: response.answer, citations: response.citations || [], sourceTimestamp: response.sourceTimestamp, correlationId: response.correlationId });
                setPreviewState('idle');
            } else {
                const code = String(response.code || '').toUpperCase();
                if (code === 'PREVIEW_NO_MATCH' || /UNGROUNDED|NO_GROUNDED|NO_ANSWER/.test(code)) setPreviewState('ungrounded');
                else if (code === 'PREVIEW_EMPTY') { setPreviewState('not-ready'); setPreviewError('В базе знаний пока нет документов с текстом. Добавьте документ или заметку.'); }
                else if (code === 'PREVIEW_INDEXING') { setPreviewState('not-ready'); setPreviewError('Документы ещё обрабатываются. Дождитесь завершения обработки и повторите вопрос.'); }
                else if (/NOT_READY|NO_DOCUMENT|PROCESSING|INDEX/.test(code)) { setPreviewState('not-ready'); setPreviewError('Поиск по базе знаний пока недоступен. Попробуйте позже.'); }
                else if (code === 'PREVIEW_TIMEOUT') { setPreviewState('error'); setPreviewError('AVA не успела подготовить ответ. Повторите вопрос позже.'); }
                else { setPreviewState('error'); setPreviewError(code === 'PREVIEW_RATE_LIMITED' ? 'Слишком много вопросов. Подождите минуту и повторите.' : 'Не удалось подготовить предварительный ответ. Попробуйте ещё раз позже.'); }
            }
        } catch (reason: any) {
            if (!active.current || sequence !== previewSequence.current || controller.signal.aborted) return;
            const code = String(reason?.response?.data?.code || '').toUpperCase();
            if (code === 'PREVIEW_NO_MATCH' || /UNGROUNDED|NO_GROUNDED|NO_ANSWER/.test(code)) setPreviewState('ungrounded');
            else if (code === 'PREVIEW_EMPTY') { setPreviewState('not-ready'); setPreviewError('В базе знаний пока нет документов с текстом. Добавьте документ или заметку.'); }
            else if (code === 'PREVIEW_INDEXING') { setPreviewState('not-ready'); setPreviewError('Документы ещё обрабатываются. Дождитесь завершения обработки и повторите вопрос.'); }
            else if (/NOT_READY|NO_DOCUMENT|PROCESSING|INDEX/.test(code)) { setPreviewState('not-ready'); setPreviewError('Поиск по базе знаний пока недоступен. Попробуйте позже.'); }
            else if (code === 'PREVIEW_TIMEOUT' || ['ECONNABORTED', 'ETIMEDOUT'].includes(reason?.code)) {
                setPreviewState('error'); setPreviewError('AVA не успела подготовить ответ. Повторите вопрос позже.');
            }
            else { setPreviewState('error'); setPreviewError(code === 'PREVIEW_RATE_LIMITED' ? 'Слишком много вопросов. Подождите минуту и повторите.' : 'Не удалось подготовить предварительный ответ. Проверьте соединение и повторите.'); }
        } finally {
            if (active.current && sequence === previewSequence.current) { previewController.current = null; if (controller.signal.aborted) setPreviewState('idle'); }
        }
    }

    function cancelPreview() {
        previewSequence.current += 1;
        previewController.current?.abort();
        previewController.current = null;
        setPreviewState('idle');
    }

    async function watchJobs(next: CustomerJob[], controller: AbortController, attempt = 0): Promise<void> {
        if (!active.current || controller.signal.aborted) return;
        const updated = await Promise.all(next.map(async job => {
            if (['completed', 'failed'].includes(job.state)) return job;
            try {
                const status = await getUploadStatus(businessId, job.jobId, controller.signal);
                if (status.success !== true || typeof status.state !== 'string') throw new Error();
                return { ...job, state: status.result?.success === false ? 'failed' : status.state || status.status || 'queued', percent: Math.min(100, Math.max(0, Number(status.percent) || 0)) };
            } catch (_) { return { ...job, state: 'unknown' }; }
        }));
        if (!active.current || controller.signal.aborted) return;
        setJobs(updated);
        if (updated.every(job => ['completed','failed','unknown'].includes(job.state))) {
            await refresh();
            if (!active.current || controller.signal.aborted) return;
            if (updated.some(job => job.state === 'failed')) setError('Не все документы обработаны. Проверьте файлы и повторите загрузку.');
            else if (updated.some(job => job.state === 'unknown')) setError('Не удалось проверить обработку некоторых документов. Повторите проверку статуса.');
            else setNotice('Текст документов обработан. Готовность к ответам показана в списке.');
            return;
        }
        if (attempt >= 150) { setNotice('Обработка продолжается. Обновите список документов позже.'); return; }
        timer.current = setTimeout(() => void watchJobs(updated, controller, attempt + 1), 2000);
    }

    async function upload(selected: File[]): Promise<boolean> {
        if (!owner || uploadBusy.current || !selected.length) return false;
        uploadBusy.current = true;
        const controller = new AbortController();
        uploadController.current = controller;
        setError(''); setNotice(''); setUploading(true);
        const allowed = /\.(pdf|docx|txt|md|csv|png|jpe?g)$/i;
        if (selected.some(file => !allowed.test(file.name) || file.size > 20 * 1024 * 1024)) {
            setError('Поддерживаются PDF, DOCX, TXT, MD, CSV, PNG и JPEG до 20 МБ каждый.'); setUploading(false); uploadBusy.current = false; if (uploadInput.current) uploadInput.current.value = ''; return false;
        }
        try {
            const response = await uploadKnowledgeBaseFiles(businessId, selected, controller.signal);
            if (!active.current || controller.signal.aborted) return false;
            if (response.success !== true || !Array.isArray(response.results) || !response.results.length) throw { response: { data: response } };
            const entries = response.results;
            const queued: CustomerJob[] = entries.filter((entry: any) => entry.success && entry.jobId).map((entry: any) => ({ name: entry.originalName || 'Документ', jobId: String(entry.jobId), state: 'queued', percent: 0 }));
            const rejected = entries.filter((entry: any) => !entry.success).length;
            if (rejected) setError(`${rejected} файл(ов) не принято. ${customerKnowledgeUploadError({ response: { status: 400, data: response } })}`);
            if (queued.length) {
                jobsController.current?.abort();
                if (timer.current) clearTimeout(timer.current);
                const jobController = new AbortController();
                jobsController.current = jobController;
                const pending = [...jobs.filter(job => !['completed', 'failed', 'unknown'].includes(job.state)), ...queued];
                setJobs(pending); setNotice('Файлы приняты. Обрабатываем документы…'); void watchJobs(pending, jobController);
            }
            else setNotice('Документы загружены. Проверьте их в списке ниже.');
            cancelPreview(); setPreview(null);
            await refresh();
            return active.current && !controller.signal.aborted && entries.every((entry: any) => entry.success === true);
        } catch (cause) { if (active.current && !controller.signal.aborted) setError(customerKnowledgeUploadError(cause)); return false; }
        finally { uploadBusy.current = false; if (active.current && !controller.signal.aborted) { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; } }
    }

    async function addText(event: React.FormEvent) {
        event.preventDefault();
        if (!textTitle.trim() || !textBody.trim()) return;
        const safeName = textTitle.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'Заметка';
        if (await upload([new window.File([textBody.trim()], `${safeName}.txt`, { type: 'text/plain' })])) { setTextTitle(''); setTextBody(''); }
    }

    async function remove(file: CustomerFile) {
        if (!owner || deleteController.current || !window.confirm(`Удалить «${file.originalName}» из базы знаний?`)) return;
        const controller = new AbortController();
        deleteController.current = controller;
        setDeletingId(file.id); setError(''); setNotice('');
        try { const response = await deleteNativeKnowledgeDocument(businessId, file.id, controller.signal); if (!active.current || controller.signal.aborted) return; if (response.success !== true || response.businessId !== businessId || response.documentId !== file.id || response.deleted !== true) throw new Error(); await refresh(); if (active.current) { cancelPreview(); setPreview(null); setNotice('Документ удалён.'); } }
        catch (_) { if (active.current) setError('Не удалось удалить документ. Обновите список и попробуйте снова.'); }
        finally { if (deleteController.current === controller) deleteController.current = null; if (active.current && !controller.signal.aborted) setDeletingId(null); }
    }

    return <div className="max-w-5xl mx-auto space-y-6">
        <header className="space-y-2"><p className="text-sm font-semibold uppercase tracking-widest text-neu-muted">Знания бизнеса</p><h1 className="text-3xl font-semibold text-neu-text">База знаний</h1><p className="text-neu-muted">{currentInstance?.name ? `${currentInstance.name} · ` : ''}Добавьте информацию и задайте контрольный вопрос AVA.</p></header>
        <section className="knowledge-preview" aria-labelledby="knowledge-preview-title">
            <div className="knowledge-preview__head"><span className="knowledge-preview__icon" aria-hidden="true"><Sparkles size={20} /></span><div><p className="knowledge-preview__eyebrow">AVA · проверка знаний</p><h2 id="knowledge-preview-title">Задать вопрос по знаниям</h2><p>Проверьте, что AVA отвечает по документам вашего бизнеса.</p></div></div>
            <form onSubmit={event => void runPreview(event)} className="knowledge-preview__form">
                <label htmlFor="knowledge-answer-question" className="knowledge-workspace__label">Вопрос для предварительного ответа</label>
                <textarea id="knowledge-answer-question" value={previewQuestion} onChange={event => { setPreviewQuestion(event.target.value); setPreviewState('idle'); setPreviewError(''); }} maxLength={1000} rows={2} placeholder="Например: Во сколько можно заселиться?" disabled={previewState === 'loading' || permissionsLoading} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                {previewState === 'loading' ? <button className="knowledge-preview__button knowledge-preview__button--cancel" type="button" onClick={cancelPreview}><X size={16} /> Отменить</button> : <button className="knowledge-preview__button" type="submit" disabled={!previewQuestion.trim() || permissionsLoading}><Sparkles size={16} /> {previewState === 'error' ? 'Повторить вопрос' : 'Подготовить ответ'} <ArrowUpRight size={15} /></button>}
            </form>
            {previewState === 'loading' && <p className="knowledge-preview__status" role="status"><Loader2 className="knowledge-preview__spinner" size={17} /> Ищем подтверждения в документах…</p>}
            {previewState === 'not-ready' && <div className="knowledge-preview__message" role="status"><AlertCircle size={18} /><p>{previewError}</p></div>}
            {previewState === 'ungrounded' && <div className="knowledge-preview__message" role="status"><AlertCircle size={18} /><p>В документах не нашлось достаточно подтверждений. Уточните вопрос или добавьте документ с этой информацией.</p></div>}
            {previewState === 'error' && <p className="knowledge-preview__error" role="alert">{previewError}</p>}
            {permissionsLoading && <p role="status" className="knowledge-preview__note">Проверяем доступ к бизнесу…</p>}
            {preview && <article className="knowledge-preview__answer" aria-label="Предварительный ответ AVA">
                <div className="knowledge-preview__answer-label"><span>{preview.question === previewQuestion.trim() && previewState === 'idle' ? 'Ответ на основе базы знаний' : `Последний ответ · ${preview.question}`}</span>{preview.sourceTimestamp && <time dateTime={preview.sourceTimestamp}>Проверено {new Date(preview.sourceTimestamp).toLocaleString('ru-RU')}</time>}</div>
                <p className="knowledge-preview__answer-text">{preview.answer}</p>
                {!!preview.citations.length && <details className="knowledge-preview__sources"><summary>Использованные документы ({preview.citations.length})</summary><ul>{preview.citations.map((citation, index) => <li key={`${citation.sourceId}-${index}`}><FileText size={15} aria-hidden="true" /><span>{citation.title}</span></li>)}</ul></details>}
            </article>}
        </section>
        <div>
            <section className="card p-5 md:p-6 space-y-5">
                <div><h2 className="text-xl font-semibold">Документы</h2><p className="text-neu-muted mt-1">Услуги, правила, цены и ответы на частые вопросы. Доступ ограничен выбранным бизнесом.</p></div>
                {owner ? <div className="space-y-2"><label htmlFor="customer-kb-upload" className="label">Загрузить файлы</label><input ref={uploadInput} id="customer-kb-upload" className="input min-h-[44px]" type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg" disabled={uploading} onChange={event => void upload(Array.from(event.target.files || []))} /><p className="text-sm text-neu-muted">PDF, DOCX, TXT, MD, CSV, PNG и JPEG · до 20 МБ на файл.</p></div> : <p className="text-neu-muted">Загрузить или удалить документы может владелец бизнеса.</p>}
                {owner && <form onSubmit={event => void addText(event)} className="space-y-3 border-t border-neu-surface-2 pt-5"><h3 className="font-semibold">Добавить текст</h3><div><label className="label" htmlFor="kb-text-title">Название заметки</label><input id="kb-text-title" className="input min-h-[44px]" value={textTitle} onChange={event => setTextTitle(event.target.value)} maxLength={80} placeholder="Например, правила возврата" required /></div><div><label className="label" htmlFor="kb-text-body">Содержание</label><textarea id="kb-text-body" className="input" rows={5} value={textBody} onChange={event => setTextBody(event.target.value)} placeholder="Напишите информацию, которую AVA должна находить" required /></div><button className="btn-secondary min-h-[44px]" disabled={uploading || !textTitle.trim() || !textBody.trim()} type="submit">{uploading ? 'Сохраняем…' : 'Добавить текст'}</button></form>}
                {error && <p role="alert" className="text-red-700">{error}</p>}{notice && <p role="status">{notice}</p>}
                {!!jobs.length && <ul className="space-y-2" aria-label="Обработка документов">{jobs.map(job => <li key={job.jobId} className="rounded-xl border border-neu-surface-2 p-3"><span className="font-medium break-all">{job.name}</span><span className="ml-2 text-neu-muted">{job.state === 'completed' ? 'Текст обработан' : job.state === 'failed' ? 'Ошибка обработки' : job.state === 'unknown' ? 'Статус обработки недоступен' : `Обработка ${job.percent}%`}</span></li>)}</ul>}
                {jobs.some(job => job.state === 'unknown') && <button type="button" className="btn-secondary min-h-[44px]" onClick={() => { jobsController.current?.abort(); const controller = new AbortController(); jobsController.current = controller; setError(''); void watchJobs(jobs, controller); }}>Проверить обработку документов</button>}
                <div className="flex items-center justify-between border-t border-neu-surface-2 pt-5"><h3 className="font-semibold">Ваши документы</h3><button type="button" className="btn-secondary min-h-[44px]" onClick={() => void refresh()} disabled={loading}>Обновить список</button></div>
                {nativeError && <p role="alert" className="text-red-700">{nativeError}</p>}
                {loading && <p role="status">Загружаем документы…</p>}{loadError && <p role="alert" className="text-red-700">{loadError}</p>}
                {!loading && !loadError && !files.length && <p className="text-neu-muted">Пока нет документов. Добавьте файл или короткую текстовую заметку, чтобы начать.</p>}
                {!!files.length && <ul className="divide-y divide-neu-surface-2">{files.map(file => <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="font-medium break-all">{file.originalName}</p><p className="text-sm text-neu-muted">{file.createdAt ? new Date(file.createdAt).toLocaleDateString('ru-RU') : 'Документ'}{file.fileSize ? ` · ${(file.fileSize / 1024 / 1024).toFixed(1)} МБ` : ''}</p><p className="text-sm text-neu-muted" role="status">{documentState(file.id)}</p></div>{owner && <button type="button" className="btn-secondary min-h-[44px]" onClick={() => setEditingDocument(editingDocument === file.id ? null : file.id)} aria-expanded={editingDocument === file.id}>Изменить текст {file.originalName}</button>}{owner && <button type="button" className="btn-secondary min-h-[44px] shrink-0" onClick={() => void remove(file)} disabled={deletingId !== null} aria-label={`Удалить ${file.originalName}`}>{deletingId === file.id ? 'Удаляем…' : 'Удалить'}</button>}{owner && editingDocument === file.id && <div className="w-full min-w-0"><CustomerDocumentEditor key={file.id} businessId={businessId} documentId={file.id} name={file.originalName} onSaved={() => { cancelPreview(); setPreview(null); setStatusRevision(value => value + 1); }} onClose={() => setEditingDocument(null)}/></div>}</li>)}</ul>}
            </section>
        </div>
        <section id="answer-improvements" className="knowledge-answer-improvements"><KnowledgeReview businessId={businessId} collapsed={hash !== '#answer-improvements'} /></section>
    </div>;
}
