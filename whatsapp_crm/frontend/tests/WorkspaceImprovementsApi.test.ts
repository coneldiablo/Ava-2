// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { featureKeys, getFeatures, updateFeatures, postPresence, generateCopilot } from '../src/improvementsApi';
vi.mock('../src/api', () => ({ api: { request: vi.fn() } }));
const flags = Object.fromEntries(featureKeys.map(key => [key, true]));
beforeEach(() => vi.clearAllMocks());
describe('workspace improvements real transport contract', () => {
    it('fails closed on tenant mismatch and invalid feature flags', async () => {
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 8, revision: 0, available: true, flags } });
        await expect(getFeatures(7)).rejects.toMatchObject({ code: 'WORKSPACE_RESPONSE_INVALID' });
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 7, revision: 0, available: false, flags } });
        await expect(getFeatures(7)).rejects.toMatchObject({ code: 'WORKSPACE_RESPONSE_INVALID' });
    });
    it('patches only selected flags and revision with cancellation and bounded timeout', async () => {
        const signal = new AbortController().signal;
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 7, revision: 4, available: true, flags: { ...flags, copilot: false } } });
        await updateFeatures(7, 3, { copilot: false }, signal);
        expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/businesses/7/workspace/features', method: 'patch', data: { revision: 3, flags: { copilot: false } }, signal, timeout: 15000 }));
    });
    it('encodes exact client and keeps typing free of message content', async () => {
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 7, participants: [], dialogueRevision: 'dialogue-v3' } });
        await postPresence(7, 'tg:42/a', { sessionId: 'session', typing: true });
        expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/businesses/7/workspace/clients/tg%3A42%2Fa/presence', data: { sessionId: 'session', typing: true } }));
    });
    it('copilot returns a draft without invoking send or task APIs', async () => {
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 7, dialogueRevision: 'r', draft: { id: 'draft', kind: 'next_action', text: 'Уточнить срок', task: { summary: 'Уточнить срок', priority: 'normal' }, sources: [] } } });
        const result = await generateCopilot(7, 'chat', 'next_action');
        expect(result.draft.task?.summary).toBe('Уточнить срок');
        expect(api.request).toHaveBeenCalledTimes(1);
        expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'post', data: { intent: 'next_action' }, timeout: 30000 }));
    });
    it('rejects an unexpected draft intent instead of creating the wrong action', async () => {
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 7, dialogueRevision: 'r', draft: { kind: 'offer', text: 'Офер', sources: [] } } });
        await expect(generateCopilot(7, 'chat', 'reply')).rejects.toMatchObject({ code: 'WORKSPACE_RESPONSE_INVALID' });
    });
});

describe('knowledge review approved backend contract', () => {
    it('uses documented confirmation body and stable idempotency key for retries', async () => {
        const { publishKnowledgeDraft, rollbackKnowledgeDraft } = await import('../src/improvementsApi');
        const draft = { id: 'draft/a', revision: 3, question: 'Вопрос', answer: 'Ответ', check: null, history: [] };
        vi.mocked(api.request).mockResolvedValue({ data: { success: true, businessId: 7, draft } });
        await publishKnowledgeDraft(7, 'draft/a', 2, undefined, 'publish-key');
        expect(api.request).toHaveBeenLastCalledWith(expect.objectContaining({ url: '/businesses/7/workspace/knowledge-review/drafts/draft%2Fa/publish', method: 'post', data: { revision: 2, confirm: true }, headers: { 'Idempotency-Key': 'publish-key' }, timeout: 30000 }));
        await rollbackKnowledgeDraft(7, 'draft/a', 3, 'version-1', undefined, 'rollback-key');
        expect(api.request).toHaveBeenLastCalledWith(expect.objectContaining({ data: { revision: 3, confirm: true, versionId: 'version-1' }, headers: { 'Idempotency-Key': 'rollback-key' } }));
    });
});
