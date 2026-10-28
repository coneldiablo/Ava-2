// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import CustomerFollowups from './CustomerFollowups';

const state = vi.hoisted(() => ({ checking: false, member: true, admin: false }));
vi.mock('../permissions', () => ({ useBusinessAccess: () => ({
    userId: 'audit-user', role: 'hotel_owner', checking: state.checking, isPlatformAdmin: state.admin,
    membership: state.member ? { capabilities: ['sales.read', 'sales.assign'] } : null,
    can: (cap: string) => !state.checking && (state.admin || ['sales.read', 'sales.assign'].includes(cap)),
}) }));
const rosterCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/sales-workspace'));
beforeEach(() => {
    state.checking = false; state.member = true; state.admin = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
        status: url.includes('/sales-workspace') ? 403 : 200,
        ok: !url.includes('/sales-workspace'),
        json: async () => url.includes('/sales-workspace') ? { success: false, code: 'BUSINESS_ACCESS_DENIED' }
            : url.includes('followup-drafts') ? { success: true, drafts: [] } : { success: true, channels: [] },
    } as Response)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('does not request the membership-only roster for a platform operator without membership', async () => {
    state.member = false; state.admin = true;
    render(<CustomerFollowups instanceId={1} chatId="synthetic" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(rosterCalls()).toHaveLength(0);
});
it('does not repeat a denied roster request when permissions are rechecked', async () => {
    const view = render(<CustomerFollowups instanceId={1} chatId="synthetic" />);
    await screen.findByText('Не удалось загрузить сотрудников. Обновите задачи, чтобы повторить.');
    expect(rosterCalls()).toHaveLength(1);
    state.checking = true; view.rerender(<CustomerFollowups instanceId={1} chatId="synthetic" />);
    state.checking = false; view.rerender(<CustomerFollowups instanceId={1} chatId="synthetic" />);
    await act(async () => {});
    expect(rosterCalls()).toHaveLength(1);
});
