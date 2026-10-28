import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { retryWorkspaceMedia, workspaceError, type WorkspaceMedia } from '../avaWorkspace';
import './MediaAttachment.css';

type Props = {
    media: WorkspaceMedia;
    messageId: string | number;
    businessId?: number;
    chatId?: string;
    canRetry?: boolean;
    onRetried?: () => void;
};

export default function MediaAttachment({ media, messageId, businessId, chatId, canRetry, onRetried }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), []);
    const kind = media.kind === 'audio' ? 'Голосовое сообщение' : media.kind === 'image' ? 'Изображение' : 'Вложение';
    const previewable = media.kind !== 'unsupported' && Boolean(media.mediaUrl) && media.errorCode !== 'WHATSAPP_MEDIA_EXPIRED';
    async function retry() {
        if (controller.current || !businessId || !chatId) return;
        const request = new AbortController();
        controller.current = request;
        setBusy(true); setFeedback(null);
        try {
            await retryWorkspaceMedia(businessId, chatId, messageId, request.signal);
            if (!request.signal.aborted) setFeedback({ error: false, text: 'Вложение распознано. Повторное сообщение клиенту не отправлено.' });
        } catch (cause) {
            if (!request.signal.aborted) setFeedback({ error: true, text: workspaceError(cause, 'Не удалось распознать вложение. Повторите попытку или проверьте файл в канале.') });
        } finally {
            if (!request.signal.aborted) { setBusy(false); onRetried?.(); }
            controller.current = null;
        }
    }
    return <div className="ava-attachment" role="group" aria-label={`${kind}: ${media.label}`} aria-busy={busy}>
        <div className="ava-attachment-heading"><strong>{kind}</strong><span>{busy ? 'Распознаём…' : media.label}</span></div>
        {media.detail && <p>{media.detail}</p>}
        {media.caption && <p>Подпись: {media.caption}</p>}
        <p role="status">{feedback && !feedback.error ? feedback.text : ''}</p>
        {feedback?.error && <p role="alert">{feedback.text}</p>}
        {previewError && <p role="alert">{previewError}</p>}
        <div className="ava-attachment-actions">
            {previewable && <button type="button" className="btn-secondary" aria-expanded={expanded} onClick={() => { setPreviewError(''); setExpanded(value => !value); }}>
                {expanded ? 'Скрыть вложение' : media.kind === 'audio' ? 'Прослушать запись' : 'Открыть изображение'}
            </button>}
            {canRetry && media.canRetry && businessId && chatId && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void retry()}>
                <RefreshCw size={14} aria-hidden="true" />{busy ? 'Распознаём…' : 'Повторить распознавание'}
            </button>}
        </div>
        {expanded && media.mediaUrl && <div className="ava-attachment-preview">
            {media.kind === 'image'
                ? <img src={media.mediaUrl} alt={media.caption || 'Изображение от клиента'} loading="lazy" onError={() => setPreviewError('Не удалось загрузить изображение. Закройте вложение и откройте снова или проверьте файл в канале.')} />
                : <audio controls preload="metadata" src={media.mediaUrl} aria-label="Голосовое сообщение клиента" onError={() => setPreviewError('Не удалось загрузить запись. Закройте вложение и откройте снова или проверьте файл в канале.')} />}
        </div>}
    </div>;
}
