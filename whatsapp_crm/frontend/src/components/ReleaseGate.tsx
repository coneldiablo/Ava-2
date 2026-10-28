import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useReleaseFlags } from '../hooks/useReleaseFlags';
import { LoadState } from './WorkspaceUi';
import type { ReleaseFlags } from '../avaWorkspace';

export default function ReleaseGate({ feature, children, fallback }: { feature: keyof ReleaseFlags; children: ReactNode; fallback?: ReactNode }) {
    const release = useReleaseFlags();
    if (release.canRead === false && !release.checking && fallback) return <>{fallback}</>;
    if (!release.data) return <section className="aw-page"><h1>{feature === 'analytics' ? 'Аналитика' : 'Рабочее пространство'}</h1><LoadState loading={release.loading || release.checking} error={release.error} reload={release.reload} empty="Не удалось получить доступ к настройкам выпуска." /></section>;
    if (!release.data.flags[feature]) return fallback || <section className="aw-page"><h1>{feature === 'analytics' ? 'Новая аналитика отключена' : 'Функция отключена'}</h1><p className="aw-empty">Владелец бизнеса может включить её в разделе AI → Выпуск функций.</p><Link className="aw-button" to={feature === 'analytics' ? '/analytics' : '/sales'}>{feature === 'analytics' ? 'Открыть аналитику каналов' : 'Открыть продажи'}</Link></section>;
    return <>{children}</>;
}
