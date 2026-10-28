import { useEffect, useId, useRef, useState } from 'react';

export function KnowledgeReviewConfirm({ action, question, answer, requireAttestation = false, busy, confirmDisabled = false, onConfirm, onCancel }: {
    action: 'publish' | 'rollback'; question: string; answer: string; requireAttestation?: boolean; busy: boolean; confirmDisabled?: boolean; onConfirm: (attested: boolean) => void; onCancel: () => void;
}) {
    const titleId = useId();
    const checkboxId = useId();
    const dialog = useRef<HTMLDivElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const [attested, setAttested] = useState(false);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        cancel.current?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
    }, []);
    const publish = action === 'publish';
    return <div className="knowledge-review__overlay"><div ref={dialog} className="knowledge-review__dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); }
        if (event.key === 'Tab') {
            const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
            if (!controls.length) { event.preventDefault(); return; }
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    }}>
        <h3 id={titleId}>{publish ? requireAttestation ? 'Подтвердить сведения и опубликовать?' : 'Опубликовать ответ?' : 'Восстановить предыдущий ответ?'}</h3>
        <p><strong>{question}</strong></p>
        <p className="knowledge-review__confirmation-answer">{answer}</p>
        <p className="knowledge-review__hint">{publish ? requireAttestation ? 'В документах пока недостаточно подтверждений. Проверьте ответ и лично подтвердите актуальность новых сведений бизнеса.' : 'Сохранённый и проверенный ответ будет опубликован в базе знаний бизнеса.' : 'AVA снова будет использовать выбранную предыдущую редакцию. История изменений сохранится.'}</p>
        {requireAttestation && <label className="knowledge-review__attestation" htmlFor={checkboxId}><input id={checkboxId} type="checkbox" checked={attested} disabled={busy} onChange={event => setAttested(event.target.checked)} /><span>Подтверждаю эти сведения как актуальную информацию бизнеса</span></label>}
        <div className="knowledge-review__actions"><button ref={cancel} type="button" className="knowledge-review__button" disabled={busy} onClick={onCancel}>Отмена</button><button type="button" className="knowledge-review__button knowledge-review__button--primary" disabled={busy || confirmDisabled || (requireAttestation && !attested)} onClick={() => onConfirm(attested)}>{busy ? 'Сохраняем…' : publish ? 'Подтвердить публикацию' : 'Подтвердить восстановление'}</button></div>
    </div></div>;
}
