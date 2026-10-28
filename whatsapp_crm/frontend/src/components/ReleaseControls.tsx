import { useState, type FormEvent } from 'react';
import { Save, ShieldCheck } from 'lucide-react';
import { useBusinessAccess } from '../permissions';
import { workspaceRequest, type ReleaseFlagsResponse } from '../avaWorkspace';
import { useReleaseFlags, notifyReleaseFlagsChanged } from '../hooks/useReleaseFlags';
import { useAction } from '../hooks/useWorkspaceResource';
import { Feedback, LoadState } from './WorkspaceUi';
import WorkspaceFeatureControls from './WorkspaceFeatureControls';
import { notifyWorkspaceFeaturesChanged } from '../hooks/useWorkspaceFeatures';

const choices = [
    { key: 'workspace', label: 'Новое рабочее пространство', description: 'Очередь «Сегодня», общая история клиента, обещания и поиск по общению.' },
    { key: 'analytics', label: 'Новая аналитика', description: 'Радар руководителя, история этапов и разбор качества общения.' },
    { key: 'autopilot', label: 'Самостоятельный AI', description: 'Исполнение опубликованных сценариев. Для запуска также нужна проверенная версия правил.' },
] as const;
export default function ReleaseControls({ businessId }: { businessId: number }) {
    const access = useBusinessAccess(); const release = useReleaseFlags();
    if (access.role !== 'hotel_owner' || !access.can('business.manage')) return null;
    return <section className="aw-surface aw-settings aw-release-controls"><header className="aw-section-heading"><ShieldCheck size={20} aria-hidden="true" /><div><h2>Выпуск функций</h2><p>Включайте новые возможности для выбранного бизнеса.</p></div></header><p className="aw-help">Начните с тестового бизнеса, затем включите функции пилотной группе и остальным. Эти переключатели сохраняются отдельно от сценариев AI.</p><LoadState {...release}>{release.data ? <ReleaseForm key={`${businessId}:${access.userId}:${release.data.revision}`} businessId={businessId} data={release.data} loading={release.loading} reload={release.reload} /> : undefined}</LoadState><WorkspaceFeatureControls businessId={businessId} /></section>;
}
function ReleaseForm({ businessId, data, loading, reload }: { businessId: number; data: ReleaseFlagsResponse; loading: boolean; reload: () => void }) {
    const access = useBusinessAccess(); const [flags, setFlags] = useState(data.flags); const action = useAction();
    const dirty = choices.some(choice => flags[choice.key] !== data.flags[choice.key]);
    function submit(event: FormEvent) {
        event.preventDefault(); if (!access.can('business.manage') || access.role !== 'hotel_owner' || loading || !dirty) return;
        void action.run('release-save', async signal => {
            const partial = Object.fromEntries(choices.filter(choice => flags[choice.key] !== data.flags[choice.key]).map(choice => [choice.key, flags[choice.key]]));
            await workspaceRequest<ReleaseFlagsResponse>(businessId, '/release-flags', 'put', { revision: data.revision, flags: partial }, signal);
            notifyReleaseFlagsChanged(businessId, access.userId);
            notifyWorkspaceFeaturesChanged(businessId, access.userId);
            return 'Переключатели выпуска сохранены для этого бизнеса.';
        }, reload);
    }
    return <form onSubmit={submit}><Feedback {...action} />{action.error && <button className="aw-link-button" type="button" onClick={reload}>Обновить переключатели</button>}<fieldset disabled={loading || Boolean(action.busy) || access.role !== 'hotel_owner' || !access.can('business.manage')} className="aw-check-list">{choices.map(choice => <label className="aw-check" key={choice.key}><input type="checkbox" disabled={data.availability?.[choice.key] === false} checked={flags[choice.key]} onChange={event => setFlags({ ...flags, [choice.key]: event.target.checked })} /><span><strong>{choice.label}</strong><small className="aw-release-description">{choice.description}{data.availability?.[choice.key] === false && ' Пока недоступно для этого бизнеса.'}</small></span></label>)}</fieldset><button className="aw-button aw-button-primary" disabled={!dirty || loading || Boolean(action.busy) || access.role !== 'hotel_owner' || !access.can('business.manage')}><Save size={16} aria-hidden="true" />Сохранить выпуск функций</button></form>;
}
