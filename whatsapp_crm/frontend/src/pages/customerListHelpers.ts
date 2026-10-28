export type CustomerListRow = {
    chatId: string; assigneeUserId?: string | null; leadStatus?: string;
    createdAt?: string; lastMessageTime?: string;
};
export type CustomerListView = 'mine' | 'queue' | 'all';

export function customerListView(params: URLSearchParams, role: string): CustomerListView {
    const requested = params.get('view');
    if (requested === 'queue' || requested === 'all' || requested === 'mine') return requested;
    return role === 'manager' ? 'mine' : 'all';
}

// These are presentation filters over the server-authorized business response.
// Names and phone suffixes never establish assignment or identity.
export function selectCustomerRows<T extends CustomerListRow>(rows: T[], params: URLSearchParams,
    role: string, userId?: string | null, now = Date.now()): T[] {
    const view = customerListView(params, role);
    const statuses = params.getAll('status');
    const from = params.get('createdFrom'), to = params.get('createdTo');
    const day = /^\d{4}-\d{2}-\d{2}$/;
    return rows.filter(row => {
        if (view === 'mine' && (!userId || row.assigneeUserId !== userId)) return false;
        if (view === 'queue' && row.assigneeUserId != null && row.assigneeUserId !== '') return false;
        if (statuses.length && !statuses.includes(row.leadStatus || 'new')) return false;
        const created = row.createdAt?.slice(0, 10);
        if (from && day.test(from) && (!created || created < from)) return false;
        if (to && day.test(to) && (!created || created > to)) return false;
        if (params.get('activity') === 'stale') {
            const last = Date.parse(row.lastMessageTime || '');
            if (Number.isFinite(last) && now - last < 72 * 3600000) return false;
        }
        return true;
    });
}

export function hasUnresolvedPlaceholders(text: string): boolean {
    return /\{\{[^{}]+\}\}|\{[\p{L}_][\p{L}\p{N}_. -]*\}|%[A-Z_][A-Z_0-9]*%|\[\[[^\]]+\]\]/u.test(text);
}
