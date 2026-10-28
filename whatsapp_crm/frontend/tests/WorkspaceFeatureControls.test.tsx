// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceFeatureControls from '../src/components/WorkspaceFeatureControls';
import { getFeatures, updateFeatures, featureKeys } from '../src/improvementsApi';
const state = vi.hoisted(() => ({ role: 'hotel_owner', userId: 'owner', allowed: true }));
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({ role: state.role, userId: state.userId, can: () => state.allowed }) }));
vi.mock('../src/improvementsApi', async () => ({ ...(await vi.importActual('../src/improvementsApi')), getFeatures: vi.fn(), updateFeatures: vi.fn() }));
beforeEach(() => {
    vi.clearAllMocks(); Object.assign(state, { role: 'hotel_owner', userId: 'owner', allowed: true });
    vi.mocked(getFeatures).mockResolvedValue({ success: true, businessId: 7, revision: 3, available: true, flags: Object.fromEntries(featureKeys.map(key => [key, true])) as Record<typeof featureKeys[number], boolean>, updatedAt: null });
});
afterEach(cleanup);
describe('independent owner feature controls', () => {
    it('patches exactly one flag using current revision', async () => {
        vi.mocked(updateFeatures).mockResolvedValue({ success: true, businessId: 7, revision: 4, available: true, flags: Object.fromEntries(featureKeys.map(key => [key, key !== 'copilot'])) as Record<typeof featureKeys[number], boolean>, updatedAt: null });
        render(<WorkspaceFeatureControls businessId={7} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: /Помощник менеджера/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить функции рабочего дня' }));
        await waitFor(() => expect(updateFeatures).toHaveBeenCalledWith(7, 3, { copilot: false }, expect.any(AbortSignal)));
    });
    it('hides controls from team lead and does not call feature endpoint', () => {
        state.role = 'sales_lead'; render(<WorkspaceFeatureControls businessId={7} />);
        expect(getFeatures).not.toHaveBeenCalled(); expect(screen.queryByRole('checkbox')).toBeNull();
    });
    it('quietly retains legacy settings when features cannot load', async () => {
        vi.mocked(getFeatures).mockRejectedValue(new Error('unavailable'));
        const view = render(<WorkspaceFeatureControls businessId={7} />);
        await waitFor(() => expect(getFeatures).toHaveBeenCalled());
        expect(view.container.textContent).toBe('');
    });
});
