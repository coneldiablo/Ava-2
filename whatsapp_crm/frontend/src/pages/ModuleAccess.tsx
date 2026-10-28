import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createModuleGrant } from '../api';

// Code is sent in a POST body, never in a URL, localStorage or analytics.
export default function ModuleAccess() {
    const { authenticated } = useAuth();
    const [error, setError] = useState('');
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        heading.current?.focus();
        if (!authenticated) return;
        const controller = new AbortController();
        const params = new URLSearchParams(window.location.search);
        const adapterId = params.get('adapter_id') || '';
        const state = params.get('state') || '';
        const challenge = params.get('code_challenge') || '';
        let form: HTMLFormElement | undefined;
        // Deferral keeps React StrictMode's first cancelled effect from issuing
        // a second grant; abort still fences any late network response.
        const timer = window.setTimeout(async () => {
            try {
                if (!/^[0-9a-f-]{36}$/.test(adapterId) || !/^[A-Za-z0-9_-]{43}$/.test(state)
                    || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('invalid');
                const grant = await createModuleGrant(adapterId, challenge, controller.signal);
                if (controller.signal.aborted) return;
                const destination = new URL(grant.callbackUrl);
                if (destination.protocol !== 'https:' || destination.port || destination.username || destination.password
                    || !/^[a-z0-9][a-z0-9-]*\.(crm|knowledge)\.meludtech\.tech$/.test(destination.hostname)
                    || destination.pathname !== '/ava-auth/callback' || destination.search || destination.hash
                    || !/^[A-Za-z0-9_-]{43}$/.test(grant.code) || grant.expiresAt <= Date.now()) throw new Error('invalid');
                form = document.createElement('form');
                form.method = 'POST'; form.action = destination.href; form.hidden = true;
                for (const [name, value] of Object.entries({ code: grant.code, state })) {
                    const input = document.createElement('input');
                    input.type = 'hidden'; input.name = name; input.value = value;
                    form.appendChild(input);
                }
                document.body.appendChild(form);
                form.submit();
            } catch (_) {
                if (!controller.signal.aborted) setError('Не удалось открыть модуль. Ссылка могла истечь или доступ изменился. Вернитесь в AVA и откройте CRM или знания ещё раз.');
            }
        }, 0);
        return () => { window.clearTimeout(timer); controller.abort(); form?.remove(); };
    }, [authenticated]);

    const pending = authenticated && !error;
    return <main className="flex min-h-screen items-center justify-center bg-neu-base px-4 py-8 text-neu-text">
        <section className="card w-full max-w-lg space-y-6 rounded-[28px] p-6 sm:p-8" aria-busy={pending}>
            <p className="text-sm font-bold tracking-widest">AVA</p>
            <h1 ref={heading} tabIndex={-1} className="font-clash-display text-3xl font-bold focus-visible:outline focus-visible:outline-2">
                {pending ? 'Открываем ваш кабинет' : 'Переход в модуль'}
            </h1>
            {error ? <p role="alert" className="leading-relaxed">{error}</p>
                : <p role="status" className="leading-relaxed">{authenticated
                    ? 'Проверяем доступ к бизнесу. Повторно вводить пароль не нужно.'
                    : 'Сессия AVA завершилась. Войдите в AVA, затем выберите CRM или знания вашего бизнеса.'}</p>}
            <a href="/" className="btn-secondary inline-flex min-h-[44px] items-center justify-center px-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
                {authenticated ? 'Вернуться в AVA' : 'Перейти ко входу в AVA'}
            </a>
        </section>
    </main>;
}
