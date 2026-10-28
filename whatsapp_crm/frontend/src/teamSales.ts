export type TeamRole = 'hotel_owner' | 'sales_lead' | 'manager' | 'observer';
export type InviteRole = Exclude<TeamRole, 'hotel_owner'>;
export type TeamMember = { userId: string | number; email: string; displayName?: string; role: TeamRole; createdAt?: string | number; capabilities: string[] };
export type InvitationDelivery = { state: 'smtp_accepted' | 'failed' | 'unknown' | 'not_attempted' | 'sending'; errorCode?: string; lastAttemptAt?: number; attempts: number };
export type TeamInvitation = { id: string | number; email: string; role: InviteRole; expiresAt: string | number; state: 'pending' | 'expired' | 'redeeming'; delivery?: InvitationDelivery };
export type RoleOption = { role: InviteRole; label: string; capabilities: string[] };
export type TeamResponse = { success: boolean; businessId: number; members: TeamMember[]; invitations: TeamInvitation[]; roleOptions: RoleOption[]; capabilities: string[]; currentUserId: string | null };
export type InviteResult = { success: boolean; invitationId?: string | number; inviteUrl: string; expiresAt: string | number; delivery?: InvitationDelivery };

export function invitationDeliveryLabel(delivery?: InvitationDelivery) {
    switch (delivery?.state) {
        case 'smtp_accepted': return 'Письмо принято почтовым сервером. Доставка во входящие пока не подтверждена.';
        case 'failed': return 'Письмо не отправлено. Можно передать ссылку лично или повторить отправку.';
        case 'sending': return 'Отправка письма выполняется. Обновите список, чтобы узнать результат.';
        case 'unknown': return 'Результат отправки письма пока не подтверждён. Проверьте почту перед повтором.';
        default: return 'Отправка письма не подтверждена. Ссылку можно передать сотруднику лично.';
    }
}
export type SalesView = 'mine' | 'queue' | 'team' | 'overview';
export type SalesPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SalesTaskStatus = 'new' | 'in_progress' | 'done' | 'cancelled';
export type SalesTask = { taskId: string; chatId: string | null; customerName: string | null; summary: string; status: SalesTaskStatus; priority: SalesPriority; dueAt: string | null; assigneeUserId: string | null; assigneeName: string | null; followupDraftId: string | null };
export type SalesClient = { chatId: string; name: string; status: string; assigneeUserId: string | null; assigneeName: string | null; lastContactAt: string | null };
export type SalesMember = { userId: string; displayName: string; email: string; role: TeamRole; openTasks: number; overdueTasks: number };
export type SalesWorkspaceResponse = { success: boolean; businessId: number; view: SalesView; currentUserId: string; capabilities: string[]; summary: { openTasks: number; overdueTasks: number; pendingFollowups: number; unassignedClients: number }; members: SalesMember[]; tasks: SalesTask[]; clients: SalesClient[]; pagination: { page: number; pageSize: number; totalTasks: number; totalClients: number } };
export type SalesTaskInput = { chatId: string; summary: string; dueAt?: string | null; priority?: SalesPriority; assigneeUserId?: string | null };
export type SalesTaskUpdate = Partial<Omit<SalesTaskInput, 'chatId'>> & { status?: SalesTaskStatus };

export function roleLabel(role: string) {
    return ({ hotel_owner: 'Владелец', sales_lead: 'Руководитель продаж', manager: 'Менеджер', observer: 'Наблюдатель' } as Record<string, string>)[role] || 'Участник';
}
export function readableDate(value?: string | number | null) {
    if (value == null || value === '') return 'Без срока';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Дата недоступна' : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
export function actionError(error: unknown, fallback: string) {
    const data = (error as { response?: { data?: { code?: string; error_code?: string } } })?.response?.data;
    const code = data?.code || data?.error_code || (error as { code?: string })?.code;
    const messages: Record<string, string> = {
        CAPABILITY_DENIED: 'Ваши права изменились. Доступ обновлён; повторите действие, если оно доступно.',
        BUSINESS_ACCESS_DENIED: 'Доступ к этому бизнесу изменился. Выберите доступный бизнес.',
        TEAM_SELF_ACCESS_PROTECTED: 'Свой доступ изменить нельзя. Обратитесь к другому владельцу.',
        TEAM_LAST_OWNER: 'В бизнесе должен остаться хотя бы один владелец.',
        ACCOUNT_ALREADY_MEMBER: 'Этот сотрудник уже в команде.', ACCOUNT_NOT_ACTIVE: 'Аккаунт сотрудника пока не активирован.',
        INVITATION_INVALID: 'Приглашение больше не действует. Попросите новую ссылку.',
        INVITATION_RESEND_COOLDOWN: 'Письмо недавно отправлялось. Подождите минуту и повторите попытку.',
        TEAM_ENROLLMENT_RECONCILIATION_REQUIRED: 'Добавление сотрудника требует проверки администратором AVA. Обратитесь в поддержку для завершения доступа.',
        TEAM_ORIGIN_REQUIRED: 'Обновите страницу AVA и повторите действие.', TEAM_UNAVAILABLE: 'Команда временно недоступна. Повторите позже.',
        SALES_TASK_ASSIGNED: 'Задачу уже взял другой сотрудник. Обновите список.', SALES_CLIENT_ASSIGNED: 'Клиента уже взял другой сотрудник. Обновите очередь.',
        SALES_DELIVERY_PENDING: 'Результат отправки ещё уточняется. Изменить ответственного можно после проверки отправки.',
        SALES_TASK_SCOPE_DENIED: 'Работать с этой задачей может её ответственный или руководитель.', SALES_CLIENT_SCOPE_DENIED: 'Этот клиент закреплён за другим сотрудником.',
        SALES_TASK_NOT_FOUND: 'Задача больше недоступна. Обновите список.', SALES_TASK_CLOSED: 'Задача уже закрыта. Обновите список.',
        SALES_STATUS_TRANSITION: 'Такое изменение состояния сейчас недоступно.', SALES_ASSIGNEE_INVALID: 'Сотрудник больше не может принимать задачи. Обновите список.',
        SALES_WORKSPACE_UNAVAILABLE: 'Рабочее место временно недоступно. Повторите позже.', SALES_INPUT_INVALID: 'Проверьте клиента, текст и срок задачи.',
    };
    return messages[code || ''] || fallback;
}
