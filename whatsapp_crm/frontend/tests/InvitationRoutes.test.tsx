// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../src/App';

const auth = vi.hoisted(() => ({ authenticated: false, loading: false }));
vi.mock('../src/context/AuthContext', () => ({
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
    useAuth: () => auth,
}));
vi.mock('../src/pages/AcceptInvitation', () => ({ default: () => <div>team invitation route</div> }));
vi.mock('../src/pages/OwnerInvitation', () => ({ default: () => <div>owner invitation route</div> }));

beforeEach(() => { auth.authenticated = false; auth.loading = false; sessionStorage.clear(); });
afterEach(() => cleanup());

describe('invitation routes', () => {
    it.each([
        ['/invite/', 'team invitation route'],
        ['/owner-invite/', 'owner invitation route'],
    ])('renders %s with a trailing slash', (path, content) => {
        window.history.replaceState(null, '', path);
        render(<App />);
        expect(screen.getByText(content)).toBeTruthy();
    });

    it.each([
        ['/invite/#team-proof', 'team invitation route', true, false],
        ['/owner-invite/#owner-proof', 'owner invitation route', true, false],
        ['/invite?source=email#team-proof', 'team invitation route', false, true],
        ['/owner-invite?source=email#owner-proof', 'owner invitation route', false, true],
    ])('preserves the invitation at %s independently of session state', (path, content, authenticated, loading) => {
        Object.assign(auth, { authenticated, loading });
        window.history.replaceState(null, '', path);
        render(<App />);
        expect(screen.getByText(content)).toBeTruthy();
        expect(window.location.pathname + window.location.search + window.location.hash).toBe(path);
    });

    it('shows the first visit choice on the public root without redirecting', () => {
        window.history.replaceState(null, '', '/');
        render(<App />);
        expect(screen.getByRole('link', { name: /Создать бизнес/ }).getAttribute('href')).toBe('/register');
        expect(screen.getAllByRole('link', { name: /^Войти/ }).some(link => link.getAttribute('href') === '/login')).toBe(true);
        expect(window.location.pathname).toBe('/');
    });
});
