// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { AxiosError } from 'axios';
import { getAiModels, getAiProviders, getInstances, updateInstance } from '../src/api';

const transport = vi.hoisted(() => ({
    requests: [] as InternalAxiosRequestConfig[], reply: {} as unknown, failure: undefined as unknown,
    delayedReply: undefined as (() => Promise<unknown>) | undefined,
}));
// Exercise real Axios serialization, instance defaults, cancellation and interceptors;
// the adapter supplies controlled responses without contacting AITunnel or production.
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return {
        ...actual,
        default: {
            ...actual.default,
            create: (config: AxiosRequestConfig) => actual.default.create({
                ...config,
                adapter: async (request: InternalAxiosRequestConfig) => {
                    transport.requests.push(request);
                    if (transport.failure) throw transport.failure;
                    const data = transport.delayedReply ? await transport.delayedReply() : transport.reply;
                    return { data, status: 200, statusText: 'OK', headers: {}, config: request };
                },
            }),
        },
    };
});

const modelId = 'vendor/model:2026-09+exact';
beforeEach(() => {
    transport.requests.length = 0;
    transport.reply = {};
    transport.failure = undefined;
    transport.delayedReply = undefined;
});
afterEach(() => vi.restoreAllMocks());

function assertRequest(method: string, url: string, timeout: number, signal?: AbortSignal) {
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0];
    expect(request.method).toBe(method);
    expect(request.url).toBe(url);
    expect(request.baseURL).toBe('/api');
    expect(request.withCredentials).toBe(true);
    expect(request.timeout).toBe(timeout);
    expect(request.signal).toBe(signal);
    return request;
}

describe('AITunnel model API contracts', () => {
    it.each([4, 19])('requests the real catalogue for tenant %s without fallback models', async businessId => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, models: [{ id: `${businessId}/model:exact`, name: `Каталог ${businessId}` }] };
        const response = await getAiModels(businessId, signal);
        const request = assertRequest('get', `/ai/models/${businessId}`, 20_000, signal);
        expect(request.data).toBeUndefined();
        expect(response).toBe(transport.reply);
    });

    it.each([4, 19])('saves the exact model ID in the tenant %s PUT body', async businessId => {
        const signal = new AbortController().signal;
        const body = { yandexGptModelUri: modelId };
        transport.reply = { success: true, instance: { id: businessId, yandexGptModelUri: modelId } };
        const response = await updateInstance(businessId, body, signal);
        const request = assertRequest('put', `/instances/${businessId}`, 15_000, signal);
        expect(JSON.parse(request.data)).toEqual(body);
        expect(response).toBe(transport.reply);
        expect(request.headers.get('Content-Type')).toContain('application/json');
    });

    it('uses the existing instances list for persisted readback and preserves both tenant records', async () => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, instances: [{ id: 4, yandexGptModelUri: modelId }, { id: 19, yandexGptModelUri: 'other/model:19' }] };
        const response = await getInstances(signal);
        const request = assertRequest('get', '/instances', 15_000, signal);
        expect(request.data).toBeUndefined();
        expect(response).toBe(transport.reply);
        expect(response.instances).toEqual([{ id: 4, yandexGptModelUri: modelId }, { id: 19, yandexGptModelUri: 'other/model:19' }]);
    });

    it('keeps optional AbortSignal compatibility for existing callers', async () => {
        transport.reply = { success: true, instances: [] };
        await getInstances();
        assertRequest('get', '/instances', 15_000);
        transport.requests.length = 0;
        transport.reply = { success: true, models: [] };
        await getAiModels(4);
        assertRequest('get', '/ai/models/4', 20_000);
        transport.requests.length = 0;
        transport.reply = { success: true, instance: { id: 4, yandexGptModelUri: modelId } };
        await updateInstance(4, { yandexGptModelUri: modelId });
        assertRequest('put', '/instances/4', 15_000);
    });

    it('preserves failure envelopes and transport errors for the component to report accurately', async () => {
        transport.reply = { success: false, code: 'MODELS_UNAVAILABLE' };
        expect(await getAiModels(4)).toBe(transport.reply);
        const failure = new AxiosError('Controlled timeout', 'ECONNABORTED');
        transport.failure = failure;
        await expect(updateInstance(4, { yandexGptModelUri: modelId })).rejects.toBe(failure);
        await expect(getInstances()).rejects.toBe(failure);
    });

    it('rejects an already cancelled catalogue request before reaching the adapter', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(getAiModels(4, controller.signal)).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        expect(transport.requests).toHaveLength(0);
    });

    it('rejects a late catalogue response after cancellation instead of resolving old models', async () => {
        let release!: (data: unknown) => void;
        transport.delayedReply = () => new Promise(resolve => { release = resolve; });
        const controller = new AbortController();
        const pending = getAiModels(4, controller.signal);
        const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        assertRequest('get', '/ai/models/4', 20_000, controller.signal);
        controller.abort();
        release({ success: true, models: [{ id: 'old/tenant-four' }] });
        await rejected;
    });

    it('dispatches the existing unauthorized event when model loading loses its session', async () => {
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        const failure = new AxiosError('Controlled expired session', 'ERR_BAD_REQUEST');
        failure.response = { status: 401, statusText: 'Unauthorized', data: { success: false }, headers: {}, config: {} as InternalAxiosRequestConfig };
        transport.failure = failure;
        await expect(getAiModels(19)).rejects.toBe(failure);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect((dispatch.mock.calls[0][0] as Event).type).toBe('crm:unauthorized');
    });
});


describe('Gemini provider API contracts', () => {
    it('requests server-owned provider availability for the chosen business', async () => {
        const signal = new AbortController().signal;
        transport.reply = { success: true, providers: [{ id: 'gemini', configured: true }] };
        expect(await getAiProviders(4, signal)).toBe(transport.reply);
        assertRequest('get', '/ai/providers/4', 15_000, signal);
    });
    it.each(['gemini', 'aitunnel'] as const)('loads the explicit %s catalog without changing the saved provider', async provider => {
        const signal = new AbortController().signal;
        await getAiModels(19, signal, provider);
        const request = assertRequest('get', '/ai/models/19', 20_000, signal);
        expect(request.params).toEqual({ provider });
        expect(request.data).toBeUndefined();
    });
});
