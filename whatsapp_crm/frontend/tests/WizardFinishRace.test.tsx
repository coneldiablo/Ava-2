// Real wizard/editor with a deferred acknowledgement; provider/session data are synthetic.
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OnboardingGuide from '../src/pages/OnboardingGuide';

const fixture = vi.hoisted(() => {
    let confirm!: (value: boolean) => void;
    const promise = new Promise<boolean>(resolve => { confirm = resolve; });
    return { confirm, promise, complete: vi.fn().mockResolvedValue(true), confirmStep: vi.fn(() => promise) };
});
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, userId: 'qa-owner', loginName: 'qa-owner@example.test',
    role: 'customer', permissionsLoading: false, canCreateBusiness: true,
    memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'business.manage'] }] }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 7,
    currentInstance: { id: 7, name: 'QA business' }, instancesState: 'ready', refreshInstances: vi.fn() }) }));
vi.mock('../src/context/OnboardingContext', () => ({ useOnboarding: () => ({ phase: 'pending', busy: false, error: '',
    state: { businessId: 7, status: 'pending', confirmedSteps: ['business', 'voice', 'knowledge', 'channels'], completedAt: null },
    confirmStep: fixture.confirmStep, complete: fixture.complete }) }));
vi.mock('../src/api', () => ({ createInstance: vi.fn(), getKnowledgeBaseStats: vi.fn().mockResolvedValue({ stats: { totalDocuments: 0 } }),
    getChannelStatus: vi.fn().mockResolvedValue({ channels: {} }) }));

beforeEach(() => {
    for (const name of ['localStorage', 'sessionStorage']) {
        const values = new Map<string, string>();
        vi.stubGlobal(name, { getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() });
    }
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('does not complete from an approval invalidated while review acknowledgement is pending', async () => {
    localStorage.setItem('ava:guide:v1:qa-owner@example.test:7', JSON.stringify({ step: 4, viewed: [] }));
    const draft = { id: 'qa-approved', status: 'approved', links: ['https://example.test'], supplement: '',
        systemPrompt: 'QA saved instructions', sources: [] };
    const profile = { businessId: 7, name: 'QA business', systemPrompt: draft.systemPrompt };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({ ok: true,
        json: async () => ({ success: true, businessId: 7, profile,
            draft: url.endsWith('/assistant-draft') && init?.method === 'POST'
                ? { ...draft, id: 'qa-new-unapproved', status: 'draft', systemPrompt: 'QA unsaved instructions' } : draft }) })));
    render(<MemoryRouter><OnboardingGuide /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Завершить настройку' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Завершить настройку' }));
    expect(fixture.confirmStep).toHaveBeenCalledWith('review');
    // The real embedded editor remains mounted during the pending acknowledgement.
    const back = screen.getAllByRole('button', { name: /Назад/ }).find(button => button.className.includes('assistant-builder__action'))!;
    expect(back.matches(':disabled')).toBe(true);
    // Synthetic dispatch deliberately bypasses the browser fieldset lock to test the fresh revision guard too.
    fireEvent.click(back);
    fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
    await waitFor(() => expect((screen.getByLabelText('Инструкции ассистента') as HTMLTextAreaElement).value).toBe('QA unsaved instructions'));
    expect(screen.getByRole('button', { name: /Завершить настройку|Сохраняем…/ }).hasAttribute('disabled')).toBe(true);
    await act(async () => { fixture.confirm(true); await fixture.promise; });
    // A stale click must not complete/hide a wizard whose latest draft is unsaved.
    expect(fixture.complete).not.toHaveBeenCalled();
});
