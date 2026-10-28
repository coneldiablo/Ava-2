import { useState, type FormEvent } from 'react';
import { useBusinessAccess } from '../permissions';
import { updateFeatures, type WorkspaceFeaturesResponse } from '../improvementsApi';
import { notifyWorkspaceFeaturesChanged, useWorkspaceFeatures } from '../hooks/useWorkspaceFeatures';
import { useAction } from '../hooks/useWorkspaceResource';
import { Feedback } from './WorkspaceUi';

const choices = [
    { key: 'queueFlow', label: 'Разобрать обращения', description: 'Переход к следующему клиенту с сохранением черновика.' },
    { key: 'collaboration', label: 'Совместная работа', description: 'Присутствие коллег и проверка изменений перед ответом.' },
    { key: 'shifts', label: 'Смены и нагрузка', description: 'Доступность сотрудников и предел новых назначений.' },
    { key: 'attention', label: 'Требует внимания', description: 'Сроки и обращения, которым нужна помощь.' },
    { key: 'copilot', label: 'Помощник менеджера', description: 'Подготовка ответа, предложения или следующего действия.' },
    { key: 'knowledgeReview', label: 'Знания из обращений', description: 'Подготовка, проверка и утверждение ответов для базы знаний.' },
] as const;
export default function WorkspaceFeatureControls({ businessId }: { businessId: number }) {
    const access = useBusinessAccess();
    const owner = access.role === 'hotel_owner' && access.can('business.manage');
    const resource = useWorkspaceFeatures(owner ? businessId : null, owner ? access.userId : null);
    if (!owner || !resource.features) return null;
    return <section className="aw-settings aw-improvement-controls" aria-label="Функции рабочего дня"><h3>Функции рабочего дня</h3><p className="aw-help">Выберите возможности, которые нужны вашей команде.</p><FeatureForm key={`${businessId}:${access.userId}:${resource.features.revision}`} data={resource.features} loading={resource.loading} refresh={resource.refresh} /></section>;
}
function FeatureForm({ data, loading, refresh }: { data: WorkspaceFeaturesResponse; loading: boolean; refresh: () => void }) {
    const access = useBusinessAccess(); const [flags, setFlags] = useState(data.flags); const action = useAction();
    const dirty = choices.some(choice => flags[choice.key] !== data.flags[choice.key]);
    function submit(event: FormEvent) {
        event.preventDefault();
        if (!dirty || loading || access.role !== 'hotel_owner' || !access.can('business.manage')) return;
        void action.run('workspace-features', async signal => {
            const changed = Object.fromEntries(choices.filter(choice => flags[choice.key] !== data.flags[choice.key]).map(choice => [choice.key, flags[choice.key]]));
            await updateFeatures(data.businessId, data.revision, changed, signal);
            if (signal.aborted) return;
            notifyWorkspaceFeaturesChanged(data.businessId, access.userId);
            return 'Функции рабочего дня сохранены.';
        }, refresh);
    }
    return <form onSubmit={submit}><Feedback {...action} />{action.error && <button className="aw-link-button" type="button" onClick={refresh}>Обновить настройки функций</button>}<fieldset className="aw-check-list" disabled={loading || Boolean(action.busy) || access.role !== 'hotel_owner' || !access.can('business.manage')}><legend className="sr-only">Возможности для команды</legend>{choices.map(choice => <label className="aw-check" key={choice.key}><input type="checkbox" checked={flags[choice.key]} onChange={event => setFlags(previous => ({ ...previous, [choice.key]: event.target.checked }))} /><span><strong>{choice.label}</strong><small className="aw-release-description">{choice.description}</small></span></label>)}</fieldset><button className="aw-button aw-button-primary" disabled={!dirty || loading || Boolean(action.busy)}>Сохранить функции рабочего дня</button></form>;
}
