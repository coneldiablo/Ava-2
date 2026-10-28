import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { createInstance, deleteInstance } from '../api';
import { Plus, Building2, Power, Trash2, PowerOff, Coffee, Store, Hotel } from 'lucide-react';
import { BusinessType, getBusinessType, getBusinessTypeLabel, isCoffeeBusiness } from '../businessProfiles';

export default function InstanceManager() {
    const { instances, refreshInstances, setInstanceId } = useInstance();
    const { refreshAuth, role, memberships } = useAuth();
    const canCreate = role === 'platform_admin' || memberships.length === 0 || memberships.some(item => item.role === 'hotel_owner');
    const navigate = useNavigate();
    const requestRef = useRef({ payload: '', key: '' });
    const submitting = useRef(false);
    const [createError, setCreateError] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [businessType, setBusinessType] = useState<BusinessType>('hotel');
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<number | null>(null);

    const handleCreate = async () => {
        if (!newName.trim() || submitting.current) return;
        submitting.current = true;
        setCreating(true);
        setCreateError('');
        try {
            const payload = {
                name: newName.trim(),
                businessType,
                salesGoal: businessType === 'hotel' ? 'call' : undefined,
            };
            const serialized = JSON.stringify(payload);
            if (requestRef.current.payload !== serialized) requestRef.current = { payload: serialized, key: crypto.randomUUID() };
            const result = await createInstance(payload, requestRef.current.key);
            await refreshInstances();
            await refreshAuth();
            setInstanceId(result.instance.id);
            requestRef.current = { payload: '', key: '' };
            setNewName('');
            setBusinessType('hotel');
            setIsCreating(false);
            navigate('/integrations');
        } catch (e: any) {
            setCreateError(e?.response?.data?.code === 'BUSINESS_QUOTA_EXCEEDED'
                ? 'Лимит бизнесов для вашего доступа достигнут. Обратитесь в поддержку AVA.'
                : 'Не удалось подтвердить создание бизнеса. Повторите попытку — повторный запрос не создаст дубликат.');
        }
        setCreating(false);
        submitting.current = false;
    };

    const handleDelete = async (id: number, name: string) => {
        if (!confirm(`Удалить бизнес "${name}" и все его данные (клиенты, сообщения, история)?`)) return;
        setDeleting(id);
        try {
            await deleteInstance(id);
            await refreshInstances();
        } catch (e) {
            alert('Ошибка при удалении');
        }
        setDeleting(null);
    };

    return (
        <div className="max-w-4xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-neu-text">Бизнесы</h1>
                    <p className="text-neu-muted text-sm mt-1">Выберите бизнес или добавьте новый</p>
                </div>
                {canCreate && <button onClick={() => setIsCreating(true)} className="btn-primary min-h-[44px]">
                    <Plus size={18} /> Добавить бизнес
                </button>}
            </div>

            {/* Create Form */}
            {canCreate && isCreating && (
                <div className="card mb-6">
                    <div className="card-header">
                        <Building2 size={18} className="text-accent" />
                        <span className="font-medium text-neu-text">Новый бизнес</span>
                    </div>
                    <div className="card-body">
                        {createError && <p role="alert" className="mb-4 text-red-600">{createError}</p>}
                        <div className="mb-5 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm text-neu-muted">
                            Для нового бизнеса создаётся отдельное рабочее пространство. После создания добавьте номер, подключите WhatsApp и загрузите документы.
                        </div>
                        <div className="mb-5">
                            <label className="label">Тип бизнеса</label>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <button
                                    type="button"
                                    onClick={() => setBusinessType('hotel')}
                                    className={`text-left rounded-xl border p-4 transition-all ${
                                        businessType === 'hotel'
                                            ? 'border-accent bg-accent/10'
                                            : 'border-white/10 bg-neu-surface-2 hover:border-white/20'
                                    }`}
                                >
                                    <div className="mb-2 flex items-center gap-3">
                                        <Hotel size={20} className="text-accent" />
                                        <span className="font-semibold text-neu-text">Отель</span>
                                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">Рекомендуется</span>
                                    </div>
                                    <p className="text-xs text-neu-muted">WhatsApp, звонки AVA, SIP, кампании и гостиничная база знаний.</p>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBusinessType('standard')}
                                    className={`text-left rounded-xl border p-4 transition-all ${
                                        businessType === 'standard'
                                            ? 'border-accent bg-accent/10'
                                            : 'border-white/10 bg-neu-surface-2 hover:border-white/20'
                                    }`}
                                >
                                    <div className="flex items-center gap-3 mb-2">
                                        <Store size={20} className="text-accent" />
                                        <span className="font-semibold text-neu-text">Обычный бизнес</span>
                                    </div>
                                    <p className="text-xs text-neu-muted">Лиды, квалификация, созвон, предложение и успешная сделка.</p>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBusinessType('coffee_shop')}
                                    className={`text-left rounded-xl border p-4 transition-all ${
                                        businessType === 'coffee_shop'
                                            ? 'border-amber-400 bg-amber-400/10'
                                            : 'border-white/10 bg-neu-surface-2 hover:border-white/20'
                                    }`}
                                >
                                    <div className="flex items-center gap-3 mb-2">
                                        <Coffee size={20} className="text-amber-400" />
                                        <span className="font-semibold text-neu-text">Кофейня</span>
                                    </div>
                                    <p className="text-xs text-neu-muted">Заказ, время самовывоза, передача бариста и подтверждение приготовления.</p>
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                            <div className="flex-1">
                                <label htmlFor="new-business-name" className="label">Название</label>
                                <input
                                    id="new-business-name"
                                    className="input"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleCreate()}
                                    placeholder={businessType === 'hotel'
                                        ? 'Например: Отель «Москва»'
                                        : businessType === 'coffee_shop'
                                            ? 'Например: Кофейня «Акцент»'
                                            : 'Например: Салон «Beauty»'}
                                    autoFocus
                                />
                            </div>
                            <button onClick={handleCreate} disabled={creating || !newName.trim()} className="btn-primary h-[46px]">
                                {creating ? 'Создание...' : 'Создать'}
                            </button>
                            <button disabled={creating} onClick={() => { setIsCreating(false); setNewName(''); setBusinessType('hotel'); }} className="btn-secondary h-[46px]">
                                Отмена
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Table */}
            {instances.length === 0 ? (
                <div className="card">
                    <div className="card-body flex flex-col items-center justify-center py-16">
                        <div className="w-16 h-16 bg-neu-surface-2 rounded-2xl flex items-center justify-center mb-4 shadow-neu-raised-sm">
                            <Building2 size={32} className="text-neu-muted" />
                        </div>
                        <p className="text-neu-muted">У вас пока нет бизнесов</p>
                        <p className="text-xs text-neu-dim mt-1">{canCreate ? 'Нажмите «Добавить бизнес», чтобы начать' : 'Попросите владельца бизнеса предоставить вам доступ'}</p>
                    </div>
                </div>
            ) : (
                <div className="card">
                    <table className="w-full text-left">
                        <thead>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                {role === 'platform_admin' && <th className="px-6 py-4 font-medium text-neu-muted text-xs uppercase tracking-wider">ID</th>}
                                <th className="px-6 py-4 font-medium text-neu-muted text-xs uppercase tracking-wider">Название</th>
                                <th className="px-6 py-4 font-medium text-neu-muted text-xs uppercase tracking-wider">Тип</th>
                                <th className="px-6 py-4 font-medium text-neu-muted text-xs uppercase tracking-wider">Статус</th>
                                {role === 'platform_admin' && <th className="px-6 py-4 font-medium text-neu-muted text-xs uppercase tracking-wider w-20">Действия</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {instances.map(inst => (
                                <tr key={inst.id}
                                    className="hover:bg-neu-surface-2/50 transition-colors"
                                    style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                                    {role === 'platform_admin' && <td className="px-6 py-4 text-neu-muted text-sm">#{inst.id}</td>}
                                    <td className="px-6 py-4">
                                        <span className="font-medium text-neu-text">{inst.name}</span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                                            isCoffeeBusiness(inst) ? 'text-amber-400' : 'text-neu-muted'
                                        }`}>
                                            {isCoffeeBusiness(inst)
                                                ? <Coffee size={13} />
                                                : getBusinessType(inst) === 'hotel'
                                                    ? <Hotel size={13} />
                                                    : <Store size={13} />}
                                            {getBusinessTypeLabel(inst)}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        {inst.isActive !== 0 ? (
                                            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full shadow-neu-raised-sm"
                                                style={{ color: '#22c55e', background: 'rgba(34,197,94,0.08)' }}>
                                                <Power size={12} /> Включён
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full shadow-neu-raised-sm"
                                                style={{ color: '#a0a0a8', background: 'rgba(160,160,168,0.08)' }}>
                                                <PowerOff size={12} /> Выключен
                                            </span>
                                        )}
                                    </td>
                                    {role === 'platform_admin' && <td className="px-6 py-4">
                                        <button
                                            onClick={() => handleDelete(inst.id, inst.name)}
                                            disabled={deleting === inst.id}
                                            className="text-neu-muted hover:text-red-400 transition-all p-2 min-h-[44px] min-w-[44px] rounded-xl hover:bg-red-500/10 hover:shadow-neu-raised-sm focus-visible:outline focus-visible:outline-2"
                                            aria-label={`Удалить бизнес ${inst.name}`}
                                            title="Удалить бизнес"
                                        >
                                            {deleting === inst.id ? (
                                                <div className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                                            ) : (
                                                <Trash2 size={16} />
                                            )}
                                        </button>
                                    </td>}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
