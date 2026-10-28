// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { AxiosError, isCancel } from 'axios';
import {
    createBusinessGptChat, deleteNativeKnowledgeDocument, getBusinessGptChat, getBusinessGptChats,
    getKnowledgeBaseFiles, getNativeKnowledgeStatus, getUploadStatus, previewKnowledgeAnswer,
    searchKnowledgeBase, sendBusinessGptMessage, simulateChat, uploadKnowledgeBaseFiles,
} from '../src/api';
import { askDashboardAva } from '../src/pages/dashboardApi';

const transport = vi.hoisted(() => ({
    requests: [] as InternalAxiosRequestConfig[],
    posts: [] as { url: string; data: unknown; options?: AxiosRequestConfig }[],
    reply: {} as unknown,
    failure: undefined as unknown,
    delayedReply: undefined as (() => Promise<unknown>) | undefined,
}));

// Keep Axios serialization, interceptors, cancellation and instance defaults real;
// only replace its network adapter with a controlled provider fixture.
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return {
        ...actual,
        default: {
            ...actual.default,
            create: (config: AxiosRequestConfig) => {
                const instance = actual.default.create({
                    ...config,
                    adapter: async (request: InternalAxiosRequestConfig) => {
                        transport.requests.push(request);
                        if (transport.failure) throw transport.failure;
                        const data = transport.delayedReply ? await transport.delayedReply() : transport.reply;
                        return { data, status: 200, statusText: 'OK', headers: {}, config: request };
                    },
                });
                const post = instance.post.bind(instance);
                instance.post = ((url: string, data?: unknown, options?: AxiosRequestConfig) => {
                    transport.posts.push({ url, data, options });
                    return post(url, data, options);
                }) as typeof instance.post;
                return instance;
            },
        },
    };
});

const question = 'Когда заселение?';
const chatId = 'chat/with space';
const requestId = 'fixture-request-4';
beforeEach(() => {
    transport.requests.length = 0;
    transport.posts.length = 0;
    transport.failure = undefined;
    transport.delayedReply = undefined;
    transport.reply = { success: true, businessId: 4, answer: 'Заезд после 14:00.', citations: [{ sourceId: 41, title: 'Правила' }], grounded: true };
});
afterEach(() => vi.restoreAllMocks());

function payload(request: InternalAxiosRequestConfig) {
    return typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
}
function scopedRequest(method: string, url: string, signal: AbortSignal) {
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request.method).toBe(method);
    expect(request.baseURL).toBe('/api');
    expect(request.url).toBe(url);
    expect(request.withCredentials).toBe(true);
    expect(request.signal).toBe(signal);
    expect(Number.isFinite(request.timeout)).toBe(true);
    expect(request.timeout).toBeGreaterThan(0);
    expect(request.timeout).toBeLessThanOrEqual(90_000);
    return request;
}

describe('knowledge API wire contracts', () => {
    it.each([4, 19])('preview sends the exact question in tenant %s with same-origin credentials', async businessId => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, businessId, answer: `Ответ бизнеса ${businessId}`, citations: [{ sourceId: businessId * 10 }], grounded: true };
        const response = await previewKnowledgeAnswer(businessId, question, signal);
        const request = scopedRequest('post', `/businesses/${businessId}/knowledge/preview`, signal);
        expect(payload(request)).toEqual({ question });
        expect(response).toBe(transport.reply);
        expect(request.timeout).toBeGreaterThan(30_000);
    });

    it.each([4, 19])('document search keeps the tenant %s and native search contract', async businessId => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, results: [{ id: `${businessId}-chunk`, text: `Документ ${businessId}`, score: 0.9 }] };
        const response = await searchKnowledgeBase(businessId, question, 'hybrid', 8, signal);
        expect(payload(scopedRequest('post', `/knowledge-base/${businessId}/search`, signal))).toEqual({ query: question, searchType: 'hybrid', k: 8 });
        expect(response).toBe(transport.reply);
    });

    it.each([4, 19])('loads file metadata and native status separately for business %s', async businessId => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, files: [{ id: businessId * 10, originalName: `tenant-${businessId}.txt` }] };
        expect(await getKnowledgeBaseFiles(businessId, signal)).toBe(transport.reply);
        scopedRequest('get', `/knowledge-base/${businessId}`, signal);
        transport.requests.length = 0;
        transport.reply = { success: true, businessId, onyx: 'configured', documents: [{ id: businessId * 10, state: 'submitted' }] };
        const native = await getNativeKnowledgeStatus(businessId, signal);
        scopedRequest('get', `/businesses/${businessId}/knowledge/native-status`, signal);
        expect(native).toBe(transport.reply);
        expect(native.documents[0].state).toBe('submitted');
    });

    it('uploads actual files without forcing a multipart header or fabricating retrieval readiness', async () => {
        const signal = new AbortController().signal;
        const files = [new File(['Controlled tenant fixture'], 'rules.txt', { type: 'text/plain' }), new File(['More fixture data'], 'faq.txt', { type: 'text/plain' })];
        transport.reply = { success: true, jobs: [{ jobId: 'pending-job', status: 'processing' }] };
        const response = await uploadKnowledgeBaseFiles(19, files, signal);
        const request = scopedRequest('post', '/knowledge-base/19/upload', signal);
        expect(request.data).toBeInstanceOf(FormData);
        expect((request.data as FormData).getAll('files')).toEqual(files);
        expect(transport.posts[0].options?.headers).toEqual({ 'X-AVA-Upload-Filename-Encoding': 'utf-8' });
        expect(transport.posts[0].options?.headers).not.toHaveProperty('Content-Type');
        expect(transport.posts[0].data).toBe(request.data);
        expect(response).toBe(transport.reply);
        expect(response).not.toHaveProperty('indexed');
    });

    it('encodes a job id for upload polling and carries abort/timeout controls', async () => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, job: { status: 'processing' } };
        expect(await getUploadStatus(4, 'job/1 ?pending', signal)).toBe(transport.reply);
        scopedRequest('get', '/knowledge-base/4/upload-status/job%2F1%20%3Fpending', signal);
    });

    it.each([4, 19])('uses the native document delete route for tenant %s', async businessId => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, deleted: true };
        expect(await deleteNativeKnowledgeDocument(businessId, 71, signal)).toBe(transport.reply);
        const request = scopedRequest('delete', `/businesses/${businessId}/knowledge/documents/71`, signal);
        expect(request.data).toBeUndefined();
    });

    it('uses the scoped Business GPT list/create/read/message endpoints with exact request ids', async () => {
        const signal = new AbortController().signal;
        expect(await getBusinessGptChats(19, signal)).toBe(transport.reply);
        scopedRequest('get', '/businesses/19/business-gpt/chats', signal);
        transport.requests.length = 0;
        expect(await createBusinessGptChat(19, signal)).toBe(transport.reply);
        expect(payload(scopedRequest('post', '/businesses/19/business-gpt/chats', signal))).toEqual({});
        transport.requests.length = 0;
        expect(await getBusinessGptChat(19, chatId, signal)).toBe(transport.reply);
        scopedRequest('get', '/businesses/19/business-gpt/chats/chat%2Fwith%20space', signal);
        transport.requests.length = 0;
        expect(await sendBusinessGptMessage(19, chatId, question, requestId, signal)).toBe(transport.reply);
        expect(payload(scopedRequest('post', '/businesses/19/business-gpt/chats/chat%2Fwith%20space/messages', signal))).toEqual({ question, requestId });
    });

    it.each([4, 19])('keeps simulator tenant %s inside its actual payload', async businessId => {
        const signal = new AbortController().signal;
        const data = { instanceId: businessId, message: question, history: [] };
        expect(await simulateChat(data, signal)).toBe(transport.reply);
        expect(payload(scopedRequest('post', '/simulate', signal))).toEqual(data);
    });

    it.each([4, 19])('Dashboard Ask uses its own contract for business %s', async businessId => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, answer: 'Одна сделка.', sources: [{ type: 'customer_deal', id: `${businessId}-deal` }], grounded: true, provenance: 'crm_records' };
        const response = await askDashboardAva(businessId, question, signal);
        const request = scopedRequest('post', `/dashboard/${businessId}/ai/ask`, signal);
        expect(payload(request)).toEqual({ question });
        expect(request.timeout).toBeGreaterThan(30_000);
        expect(response).toBe(transport.reply);
        expect(response.provenance).toBe('crm_records');
        expect(response).not.toHaveProperty('citations');
    });

    it('preserves empty/indexing server errors instead of producing a successful answer', async () => {
        for (const code of ['PREVIEW_EMPTY', 'PREVIEW_INDEXING', 'PREVIEW_UNGROUNDED', 'PREVIEW_TIMEOUT', 'PREVIEW_UNAVAILABLE']) {
            const failure = { isAxiosError: true, response: { status: code === 'PREVIEW_TIMEOUT' ? 504 : 409, data: { success: false, code } } };
            transport.failure = failure;
            await expect(previewKnowledgeAnswer(4, question)).rejects.toBe(failure);
        }
    });

    it('cancels an already aborted request before it reaches the provider adapter', async () => {
        const controller = new AbortController();
        controller.abort();
        let failure: unknown;
        try { await previewKnowledgeAnswer(4, question, controller.signal); } catch (error) { failure = error; }
        expect(isCancel(failure)).toBe(true);
        expect(transport.requests).toHaveLength(0);
    });

    it('rejects an in-flight late provider reply after abort, then permits a new tenant request', async () => {
        let release!: (data: unknown) => void;
        transport.delayedReply = () => new Promise(resolve => { release = resolve; });
        const controller = new AbortController();
        const pending = previewKnowledgeAnswer(4, question, controller.signal);
        const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        expect(transport.requests).toHaveLength(1);
        controller.abort();
        release({ success: true, businessId: 4, answer: 'Old tenant reply', citations: [] });
        await rejected;
        transport.delayedReply = undefined;
        transport.requests.length = 0;
        transport.reply = { success: true, businessId: 19, answer: 'New tenant reply', citations: [{ sourceId: 191 }] };
        const signal = new AbortController().signal;
        expect(await previewKnowledgeAnswer(19, question, signal)).toBe(transport.reply);
        scopedRequest('post', '/businesses/19/knowledge/preview', signal);
    });

    it.each(['preview', 'dashboard'] as const)('dispatches unauthorized once for a rejected %s response', async surface => {
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        const failure = new AxiosError('Session expired', 'ERR_BAD_REQUEST');
        failure.response = { status: 401, statusText: 'Unauthorized', data: { success: false }, headers: {}, config: {} as InternalAxiosRequestConfig };
        transport.failure = failure;
        await expect(surface === 'preview' ? previewKnowledgeAnswer(4, question) : askDashboardAva(4, question)).rejects.toBe(failure);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect((dispatch.mock.calls[0][0] as Event).type).toBe('crm:unauthorized');
    });
});
