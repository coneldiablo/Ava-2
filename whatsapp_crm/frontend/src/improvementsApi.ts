import { api } from './api';
import type { ScopedResponse } from './avaWorkspace';

export const featureKeys = ['queueFlow', 'collaboration', 'shifts', 'attention', 'copilot', 'knowledgeReview'] as const;
export type WorkspaceFeature = typeof featureKeys[number];
export type WorkspaceFeatures = Record<WorkspaceFeature, boolean>;
export type WorkspaceFeaturesResponse = ScopedResponse & { revision: number; available: boolean; flags: WorkspaceFeatures; updatedAt: string | null };
export type PresenceResponse = ScopedResponse & { participants: { userId: string; name: string; typing: boolean; expiresAt: string }[]; dialogueRevision: string };
export type AvailabilityStatus = 'available' | 'break' | 'off';
export type AvailabilityMember = { userId: string; name: string; status: AvailabilityStatus; capacity: number | null; currentLoad: number; revision: number };
export type AvailabilityResponse = ScopedResponse & { members: AvailabilityMember[] };
export type AttentionItem = { id: string; type: string; title: string; description: string; chatId: string | null; href: string; priority: string; dueAt: string | null };
export type AttentionResponse = ScopedResponse & { items: AttentionItem[]; counts: { total: number; returned: number; byType: Record<string, number> } };
export type CopilotIntent = 'reply' | 'offer' | 'next_action';
export type CopilotSource = { type: 'message' | 'call' | 'knowledge' | 'offer' | 'client' | 'task' | 'promise' | 'deal'; id: string; title: string; href: string };
export type CopilotDraft = { id: string; kind: CopilotIntent; text: string; sources: CopilotSource[]; offerId?: string; task?: { summary: string; priority: 'normal' } };
export type CopilotResponse = ScopedResponse & { draft: CopilotDraft; dialogueRevision: string };

function invalid(): never { throw Object.assign(new Error('Invalid workspace response'), { code: 'WORKSPACE_RESPONSE_INVALID' }); }
export async function improvementRequest<T extends ScopedResponse>(businessId: number, path: string, method: 'get' | 'post' | 'patch' = 'get', data?: unknown, signal?: AbortSignal, timeout = 15000): Promise<T> {
    const response = await api.request<T>({ url: `/businesses/${businessId}/workspace${path}`, method, data, signal, timeout });
    if (response.data?.success !== true || response.data.businessId !== businessId) invalid();
    return response.data;
}
function validateFeatures(result: WorkspaceFeaturesResponse) {
    if (!Number.isSafeInteger(result.revision) || result.revision < 0 || typeof result.available !== 'boolean' || !result.flags || featureKeys.some(key => typeof result.flags[key] !== 'boolean')) invalid();
    if (!result.available && featureKeys.some(key => result.flags[key])) invalid();
    return result;
}
export const getFeatures = async (id: number, signal?: AbortSignal) => validateFeatures(await improvementRequest<WorkspaceFeaturesResponse>(id, '/features', 'get', undefined, signal));
export const updateFeatures = async (id: number, revision: number, flags: Partial<WorkspaceFeatures>, signal?: AbortSignal) => validateFeatures(await improvementRequest<WorkspaceFeaturesResponse>(id, '/features', 'patch', { revision, flags }, signal));
function validatePresence(result: PresenceResponse) {
    if (typeof result.dialogueRevision !== 'string' || !result.dialogueRevision || !Array.isArray(result.participants) || result.participants.some(row => typeof row.userId !== 'string' || typeof row.name !== 'string' || typeof row.typing !== 'boolean' || typeof row.expiresAt !== 'string')) invalid();
    return result;
}
export const getPresence = async (id: number, chatId: string, signal?: AbortSignal) => validatePresence(await improvementRequest<PresenceResponse>(id, `/clients/${encodeURIComponent(chatId)}/presence`, 'get', undefined, signal));
export const postPresence = async (id: number, chatId: string, body: { sessionId: string; typing: boolean }, signal?: AbortSignal) => validatePresence(await improvementRequest<PresenceResponse>(id, `/clients/${encodeURIComponent(chatId)}/presence`, 'post', body, signal));
export const getAvailability = async (id: number, signal?: AbortSignal) => {
    const result = await improvementRequest<AvailabilityResponse>(id, '/availability', 'get', undefined, signal);
    if (!Array.isArray(result.members) || result.members.some(row => typeof row.userId !== 'string' || typeof row.name !== 'string' || !['available','break','off'].includes(row.status) || !Number.isSafeInteger(row.revision) || !Number.isFinite(row.currentLoad))) invalid();
    return result;
};
export const updateAvailability = (id: number, userId: string, body: { revision: number; status?: AvailabilityStatus; capacity?: number | null }, signal?: AbortSignal) => improvementRequest<ScopedResponse & { member: AvailabilityMember }>(id, `/availability/${encodeURIComponent(userId)}`, 'patch', body, signal);
export const getAttention = async (id: number, signal?: AbortSignal) => {
    const result = await improvementRequest<AttentionResponse>(id, '/attention', 'get', undefined, signal);
    if (!Array.isArray(result.items) || !result.counts || !Number.isFinite(result.counts.total) || result.items.some(row => typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.description !== 'string' || typeof row.href !== 'string')) invalid();
    return result;
};
export const generateCopilot = async (id: number, chatId: string, intent: CopilotIntent, signal?: AbortSignal) => {
    const result = await improvementRequest<CopilotResponse>(id, `/clients/${encodeURIComponent(chatId)}/copilot`, 'post', { intent }, signal, 30000);
    if (typeof result.dialogueRevision !== 'string' || !result.draft || result.draft.kind !== intent || typeof result.draft.text !== 'string' || !result.draft.text.trim() || !Array.isArray(result.draft.sources) || result.draft.sources.some(source => typeof source.title !== 'string' || typeof source.href !== 'string')) invalid();
    return result;
};

export type KnowledgeReviewSource = { type: 'message' | 'call'; id: string; chatId: string };
export type KnowledgeReviewCandidate = { source: KnowledgeReviewSource; text: string; createdAt: string };
export type KnowledgeReviewCheck = { status: 'passed' | 'failed' | 'unavailable' | 'timeout' | 'manual_required'; passed: boolean; reason: string; citations: { documentId: number; chunkId: number; quote: string }[]; version: number; revision: number; sourceHash: string; knowledgeHash: string; checkedBy: string; checkedAt: string; code?: string; needsConfirmation?: boolean; contentHash?: string };
export type KnowledgeReviewApproval = { type: 'ai_grounded' | 'human_confirmed'; userId: string; revision: number; version: number; sourceHash: string; contentHash: string; approvedAt: string };
export type KnowledgeReviewAttestation = { confirm: true; revision: number; contentHash: string; sourceHash: string };
export type KnowledgeReviewVersion = { id: string; draftId: string; revision: number; version: number; kind: 'created' | 'edited' | 'checked' | 'published' | 'rollback'; question: string; answer: string; actorUserId: string; check: KnowledgeReviewCheck | null; approval?: KnowledgeReviewApproval | null; documentId: number | null; restoredVersionId: string | null; createdAt: string };
export type KnowledgeReviewDraft = { id: string; question: string; answer: string; source: KnowledgeReviewSource; status: 'draft' | 'checked' | 'published'; revision: number; version: number; authorUserId: string; check: KnowledgeReviewCheck | null; approval?: KnowledgeReviewApproval | null; currentDocumentId: number | null; sync: { state: 'local_only' | 'submitted' | 'needs_sync' | 'processing' | 'empty'; queued: boolean } | null; createdAt: string; updatedAt: string; history: KnowledgeReviewVersion[] };
export type KnowledgeReviewSnapshot = ScopedResponse & { candidates: KnowledgeReviewCandidate[]; drafts: KnowledgeReviewDraft[]; versions: KnowledgeReviewVersion[] };
export type KnowledgeReviewDraftResponse = ScopedResponse & { draft: KnowledgeReviewDraft };
export const getKnowledgeReview = async (id: number, signal?: AbortSignal) => {
    const result = await improvementRequest<KnowledgeReviewSnapshot>(id, '/knowledge-review', 'get', undefined, signal);
    if (!Array.isArray(result.candidates) || !Array.isArray(result.drafts) || !Array.isArray(result.versions) || result.drafts.some(draft => !validKnowledgeDraft(draft)) || result.candidates.some(candidate => !candidate.source || !['message','call'].includes(candidate.source.type) || typeof candidate.source.id !== 'string' || typeof candidate.source.chatId !== 'string' || typeof candidate.text !== 'string')) invalid();
    return result;
};
function validKnowledgeDraft(draft: KnowledgeReviewDraft) {
    return Boolean(draft && typeof draft.id === 'string' && typeof draft.question === 'string' && typeof draft.answer === 'string' && Number.isSafeInteger(draft.revision) && draft.revision > 0 && Array.isArray(draft.history) && (draft.check === null || (draft.check && Array.isArray(draft.check.citations) && typeof draft.check.passed === 'boolean')));
}
async function knowledgeAction(id: number, path: string, method: 'post' | 'patch', data: unknown, signal?: AbortSignal, idempotencyKey?: string) {
    const key = idempotencyKey || globalThis.crypto.randomUUID();
    const result = await api.request<KnowledgeReviewDraftResponse>({ url: `/businesses/${id}/workspace/knowledge-review${path}`, method, data, signal, timeout: 30000, headers: { 'Idempotency-Key': key } });
    if (result.data?.success !== true || result.data.businessId !== id || !validKnowledgeDraft(result.data.draft)) invalid();
    return result.data;
}
export const createKnowledgeDraft = (id: number, body: { question: string; source: KnowledgeReviewSource }, signal?: AbortSignal, key?: string) => knowledgeAction(id, '/drafts', 'post', body, signal, key);
export const updateKnowledgeDraft = (id: number, draftId: string, body: { revision: number; question: string; answer: string }, signal?: AbortSignal, key?: string) => knowledgeAction(id, `/drafts/${encodeURIComponent(draftId)}`, 'patch', body, signal, key);
export const checkKnowledgeDraft = (id: number, draftId: string, revision: number, signal?: AbortSignal, key?: string) => knowledgeAction(id, `/drafts/${encodeURIComponent(draftId)}/check`, 'post', { revision }, signal, key);
export const publishKnowledgeDraft = (id: number, draftId: string, revision: number, signal?: AbortSignal, key?: string, attestation?: KnowledgeReviewAttestation) => knowledgeAction(id, `/drafts/${encodeURIComponent(draftId)}/publish`, 'post', { revision, confirm: true, ...(attestation ? { attestation } : {}) }, signal, key);
export const rollbackKnowledgeDraft = (id: number, draftId: string, revision: number, versionId: string | undefined, signal?: AbortSignal, key?: string) => knowledgeAction(id, `/drafts/${encodeURIComponent(draftId)}/rollback`, 'post', { revision, confirm: true, ...(versionId ? { versionId } : {}) }, signal, key);
