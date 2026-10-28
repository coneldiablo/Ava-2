// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ModuleNavigation from '../src/components/ModuleNavigation';
const moduleRow = (businessId: number, state='verified') => ({ business_id: businessId, module: 'onyx', state, start_url: 'https://fixture.knowledge.meludtech.tech/ava-auth/start', allowed_actions: ['open'] });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('native knowledge navigation', () => {
    it('uses scoped credentials and opens only verified HTTPS module start paths', async () => {
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ modules: [moduleRow(7)] }) }); vi.stubGlobal('fetch', fetch);
        render(<MemoryRouter><ModuleNavigation businessId={7} /></MemoryRouter>);
        const link = await screen.findByRole('link', { name: 'Открыть Кабинет знаний' }); expect(link.getAttribute('href')).toBe(moduleRow(7).start_url); expect(fetch).toHaveBeenCalledWith('/api/businesses/7/modules', expect.objectContaining({ credentials: 'same-origin', signal: expect.any(AbortSignal) }));
    });
    it('rejects a cross-business module response and distinguishes failed provisioning from connecting', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ modules: [moduleRow(8)] }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ modules: [moduleRow(8, 'failed')] }) }));
        const view = render(<MemoryRouter><ModuleNavigation key={7} businessId={7} /></MemoryRouter>); expect(await screen.findByText('Кабинет знаний — временно недоступен')).toBeTruthy(); expect(screen.queryByRole('link', { name: 'Открыть Кабинет знаний' })).toBeNull();
        view.rerender(<MemoryRouter><ModuleNavigation key={8} businessId={8} /></MemoryRouter>); expect(await screen.findByText('Кабинет знаний — ошибка подключения')).toBeTruthy();
    });
    it('terminates hung access checks after 15 seconds and aborts again on unmount', async () => {
        vi.useFakeTimers(); const signals: AbortSignal[] = [];
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, options: {signal: AbortSignal}) => { signals.push(options.signal); return new Promise((_resolve,reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))); }));
        const view = render(<MemoryRouter><ModuleNavigation businessId={7} /></MemoryRouter>);
        await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(signals[0].aborted).toBe(true); expect(screen.getByText('Кабинет знаний — временно недоступен')).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(signals[1].aborted).toBe(false); view.unmount(); expect(signals[1].aborted).toBe(true);
    });
});
