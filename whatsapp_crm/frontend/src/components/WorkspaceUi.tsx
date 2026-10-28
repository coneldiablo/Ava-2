import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

export function Feedback({ error, notice }: { error?: string; notice?: string }) { return <>{error && <p className="aw-alert" role="alert">{error}</p>}{notice && <p className="aw-notice" role="status">{notice}</p>}</>; }
export function LoadState({ loading, error, reload, empty, children }: { loading: boolean; error: string; reload: () => void; empty?: string; children?: ReactNode }) {
    if (error && !children) return <div className="aw-empty aw-error" role="alert"><p>{error}</p><button className="aw-button" onClick={reload}><RefreshCw size={16} aria-hidden="true" />Повторить</button></div>;
    if (loading && !children) return <p className="aw-empty" role="status">Загружаем…</p>;
    return <>{error && <div className="aw-empty aw-error" role="alert"><p>{error} Последние полученные данные сохранены.</p><button className="aw-button" onClick={reload}>Повторить обновление</button></div>}{children || <p className="aw-empty">{empty || 'Пока нет данных.'}</p>}</>;
}
export function SectionLinks({ items }: { items: { href: string; label: string }[] }) { return <nav className="aw-secondary-nav" aria-label="Связанные разделы">{items.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>; }
