import axios from 'axios';

export type DashboardDays = 7 | 30 | 90;
export type Availability = 'available' | 'insufficient_data' | 'unavailable';
export type Amount = { currency: string; amountMinor: number };
export type DashboardTarget = { type: string; id: string | number; path: string | null };
export type ScoreFactor = { code: string; points: number; evidence: string };

export interface DashboardMetrics {
    success: boolean;
    business_id: number;
    period: { days: DashboardDays; timezone: string; start: string; endExclusive: string; asOf: string };
    kpis: {
        leads: { created: number; total: number; active: number };
        messages: { inbound: number; outbound: number; total: number };
        deals: { created: number; open: number; won: number; lost: number; openAmounts: Amount[]; wonAmounts: Amount[] };
        ai: { recordedSuccessfulToolRuns: number; status: 'partial' | 'available' | 'unavailable' };
    };
    series: {
        leads: { date: string; count: number }[];
        closedDeals: { date: string; count: number; amounts: Amount[] }[];
    };
    dealFunnel: { stage: string; count: number; amounts: Amount[] }[];
    currentFunnel?: { status: 'available' | 'unavailable'; scope: 'all_open'; totalOpen: number | null;
        items: { stage: string; count: number; amounts: Amount[] }[] };
    sources: { closedDeals: { status: string; description: string }; ai: { status: string; description: string } };
}

export interface DashboardPriority {
    id: string;
    kind: string;
    score: number;
    scoreFactors?: ScoreFactor[];
    title: string;
    reason: string;
    nextAction: string;
    target?: DashboardTarget | null;
    completeAction?: { method: 'PATCH'; path: string; body: { status: 'done' } } | null;
}
export interface DashboardDeal {
    id: string;
    source: string;
    title: string;
    amount?: number | null;
    currency?: string | null;
    stage?: string | null;
    lastContactAt?: string | null;
    riskReasons: ScoreFactor[];
    score: number;
    nextAction?: string | null;
    nextActionAt?: string | null;
    target?: DashboardTarget | null;
}
export interface DashboardTask {
    id: string;
    kind: string;
    title: string;
    priority?: string;
    status: string;
    dueAt?: string | null;
    target?: DashboardTarget | null;
    completeAction?: { method: 'PATCH'; path: string; body: { status: 'done' } } | null;
}
export interface DashboardIntelligence {
    success: boolean;
    instanceId: number;
    generatedAt: string;
    priorities: DashboardPriority[];
    deals: { status: Availability; reason?: string; items: DashboardDeal[] };
    dayPlan: { date: string; status: Availability; reason?: string; items: DashboardTask[]; unscheduledCount?: number };
    sentiment: { status: Availability; sampleSize: number; windowDays: number; positive?: number | null; neutral?: number | null; negative?: number | null; method?: string; reason?: string };
    agents: { status: Availability; reason?: string; items: { id: string; name: string; status: string; task?: string; target?: DashboardTarget }[] };
}

export interface DashboardSource { type: string; id: string; title?: string; createdAt?: string | null; sourceUpdatedAt?: string | null; }
export interface DashboardActivityItem {
    id: string;
    category: 'ai' | 'team' | 'client';
    kind: string;
    title: string;
    description: string;
    occurredAt: string;
    target?: DashboardTarget | null;
    source?: DashboardSource | null;
}
export interface DashboardActivityResponse {
    success: boolean;
    instanceId: number;
    period: { from: string; to: string; timezone: string };
    status: 'available' | 'unavailable';
    sourceComplete: boolean;
    coverage?: { sampledRowsComplete: boolean; deals: 'partial' | 'available' | 'unavailable'; aiActions: 'partial' | 'available' | 'unavailable'; description: string };
    items: DashboardActivityItem[];
}
export interface DashboardRecommendation {
    id: string;
    title: string;
    reason: string;
    action?: string;
    priority?: string;
    sources?: DashboardSource[];
}
export interface DashboardBriefing {
    businessId: number;
    period: { from: string; to: string };
    generatedAt: string;
    sourceUpdatedAt: string | null;
    eventCount: number;
    sourceComplete: boolean;
    summary: string;
    recommendations: DashboardRecommendation[];
    capabilities: { pdf: boolean; audio: { available: boolean; reason?: string } };
}
export interface DashboardBriefingResponse { success: boolean; briefing: DashboardBriefing; }
export interface DashboardRecommendationsResponse { success: boolean; recommendations: DashboardRecommendation[]; generatedAt: string; sourceUpdatedAt: string | null; }
export interface DashboardAskResponse {
    success: boolean;
    answer: string;
    answerStatus?: 'answered' | 'insufficient' | 'empty' | 'unavailable';
    sources: DashboardSource[];
    grounded: boolean;
    provenance?: 'crm_records' | 'aitunnel_crm' | 'gemini_crm' | 'onyx_knowledge';
    generatedAt: string;
    sourceUpdatedAt: string | null;
}
export interface DashboardOverview {
    businessId: number;
    window: { kind: 'overnight' | 'yesterday'; timezone: string; localDate: string; start: string; endExclusive: string; complete: boolean };
    asOf: string;
    status: 'available' | 'partial' | 'unavailable';
    answerStatus: 'answered' | 'insufficient' | 'empty' | 'unavailable';
    summary: string;
    grounded: boolean;
    changes?: string[];
    attention?: string[];
    outcome?: string;
    sources?: DashboardSource[];
    highlights?: { id?: string; type?: string; text: string; source?: DashboardSource }[];
    sourceRevision?: string;
    sourceUpdatedAt: string | null;
    generatedAt: string;
    summaryThrough?: string;
    limitations?: string[];
    counts?: Record<string, { status: 'available' | 'partial' | 'unavailable'; count: number | null }>;
}
export interface DashboardOverviewResponse { success: boolean; overview: DashboardOverview; }

const dashboardApi = axios.create({ baseURL: '/api', withCredentials: true });
dashboardApi.interceptors.response.use(response => response, error => {
    if (error.response?.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
    return Promise.reject(error);
});

export const getDashboardMetrics = (instanceId: number, days: DashboardDays, signal?: AbortSignal) =>
    dashboardApi.get<DashboardMetrics>(`/dashboard/${instanceId}/metrics`, { params: { days }, signal, timeout: 15_000 }).then(response => response.data);
export const getDashboardIntelligence = (instanceId: number, signal?: AbortSignal) =>
    dashboardApi.get<DashboardIntelligence>(`/dashboard/${instanceId}/intelligence`, { signal, timeout: 15_000 }).then(response => response.data);
export const getDashboardBriefing = (instanceId: number, signal?: AbortSignal) =>
    dashboardApi.get<DashboardBriefingResponse>(`/dashboard/${instanceId}/ai/briefing`, { signal, timeout: 15_000 }).then(response => response.data);
export const getDashboardRecommendations = (instanceId: number, signal?: AbortSignal) =>
    dashboardApi.get<DashboardRecommendationsResponse>(`/dashboard/${instanceId}/ai/recommendations`, { signal, timeout: 15_000 }).then(response => response.data);
export const getDashboardActivity = (instanceId: number, signal?: AbortSignal) =>
    dashboardApi.get<DashboardActivityResponse>(`/dashboard/${instanceId}/activity`, { params: { window: 'overnight' }, signal, timeout: 15_000 }).then(response => response.data);
export const getDashboardOverview = (instanceId: number, window: 'overnight' | 'yesterday', signal?: AbortSignal) =>
    dashboardApi.get<DashboardOverviewResponse>(`/dashboard/${instanceId}/ai/overview`, { params: { window }, signal, timeout: 55_000 }).then(response => response.data);
export const askDashboardAva = (instanceId: number, question: string, signal?: AbortSignal) =>
    dashboardApi.post<DashboardAskResponse>(`/dashboard/${instanceId}/ai/ask`, { question }, { signal, timeout: 55_000 }).then(response => response.data);
export const getDashboardBriefingMedia = (instanceId: number, type: 'pdf' | 'audio') =>
    dashboardApi.get<Blob>(`/dashboard/${instanceId}/ai/briefing${type === 'pdf' ? '.pdf' : '/audio'}`, { responseType: 'blob' }).then(response => response.data);
export const completeDashboardTask = (instanceId: number, taskId: string) =>
    dashboardApi.patch(`/dashboard/${instanceId}/tasks/${encodeURIComponent(taskId)}`, { status: 'done' }).then(response => response.data);
