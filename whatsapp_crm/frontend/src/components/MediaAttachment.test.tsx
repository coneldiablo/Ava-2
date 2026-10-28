// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MediaAttachment from './MediaAttachment';
import { retryWorkspaceMedia, type WorkspaceMedia } from '../avaWorkspace';
vi.mock('../avaWorkspace', () => ({ retryWorkspaceMedia: vi.fn(), workspaceError: (_error: unknown, fallback: string) => fallback }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const media = { kind: 'image', status: 'failed', canRetry: true, label: 'Распознавание не завершилось', mediaUrl: '/api/private-media', providerMessageId: 'external' } as WorkspaceMedia;
describe('shared attachment recovery', () => {
    it('announces a failed preview with a recovery action in any customer surface', () => {
        render(<MediaAttachment media={media} messageId={42} />);
        fireEvent.click(screen.getByRole('button', { name: 'Открыть изображение' }));
        fireEvent.error(screen.getByRole('img'));
        expect(screen.getByRole('alert').textContent).toContain('откройте снова');
        expect(screen.queryByRole('button', { name: 'Повторить распознавание' })).toBeNull();
    });
    it('retries recognition once, reloads its saved state, and exposes no send action', async () => {
        const reload = vi.fn();
        let resolve!: (value: unknown) => void;
        vi.mocked(retryWorkspaceMedia).mockReturnValue(new Promise(done => { resolve = done; }) as never);
        render(<MediaAttachment media={media} businessId={7} chatId="client" messageId={42} canRetry onRetried={reload} />);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить распознавание' }));
        expect(screen.getByRole('button', { name: 'Распознаём…' }).hasAttribute('disabled')).toBe(true);
        expect(retryWorkspaceMedia).toHaveBeenCalledTimes(1);
        expect(retryWorkspaceMedia).toHaveBeenCalledWith(7, 'client', 42, expect.any(AbortSignal));
        resolve({ success: true });
        await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('status').textContent).toContain('Повторное сообщение клиенту не отправлено');
        expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull();
    });
});
