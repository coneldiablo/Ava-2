const VALID_STATUSES = ['new', 'qualified', 'audit', 'offer', 'pickup_confirmed', 'ready_for_pickup', 'booked', 'junk'];
const BUSINESS_TYPES = ['standard', 'coffee_shop', 'hotel'];

const STANDARD_STATUSES = ['new', 'qualified', 'audit', 'offer', 'booked', 'junk'];
const COFFEE_STATUSES = ['new', 'qualified', 'audit', 'offer', 'pickup_confirmed', 'ready_for_pickup', 'junk'];

function resolveBusinessType(instance = {}) {
    if (instance.businessType === 'coffee_shop') {
        return 'coffee_shop';
    }
    if (instance.businessType === 'hotel') {
        return 'hotel';
    }
    if (instance.businessType === 'standard') return 'standard';
    if (instance.salesGoal === 'coffee_pickup') return 'coffee_shop';
    return 'standard';
}

function getStatusesForBusiness(instance = {}) {
    return resolveBusinessType(instance) === 'coffee_shop' ? COFFEE_STATUSES : STANDARD_STATUSES;
}

// Manager handoff: lifecycle of a task a human has to pick up after a call.
const MANAGER_TASK_STATUSES = ['new', 'in_progress', 'done', 'cancelled'];

// Reopening a closed task is allowed so a manager can undo a wrong close,
// but a task can never jump straight from done to in_progress.
const MANAGER_TASK_TRANSITIONS = Object.freeze({
    new: ['in_progress', 'done', 'cancelled'],
    in_progress: ['done', 'cancelled', 'new'],
    done: ['new'],
    cancelled: ['new'],
});

// Why the call had to leave AVA. Kept as an open vocabulary: unknown values
// fall back to 'other' instead of failing the handoff.
const MANAGER_TASK_REASONS = [
    'guest_request',
    'missing_fact',
    'booking_change',
    'booking_request',
    'complaint',
    'payment',
    'sensitive_data',
    'repeated_misunderstanding',
    'transfer_failed',
    'manual',
    'other',
];

const MANAGER_TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function normalizeManagerTaskStatus(value, fallback = 'new') {
    const status = String(value || '').trim().toLowerCase();
    return MANAGER_TASK_STATUSES.includes(status) ? status : fallback;
}

function normalizeManagerTaskReason(value, fallback = 'manual') {
    const reason = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return MANAGER_TASK_REASONS.includes(reason) ? reason : fallback;
}

function normalizeManagerTaskPriority(value, fallback = 'normal') {
    const priority = String(value || '').trim().toLowerCase();
    return MANAGER_TASK_PRIORITIES.includes(priority) ? priority : fallback;
}

function canTransitionManagerTask(from, to) {
    const current = normalizeManagerTaskStatus(from, 'new');
    const target = String(to || '').trim().toLowerCase();
    if (!MANAGER_TASK_STATUSES.includes(target)) return false;
    if (current === target) return true;
    return (MANAGER_TASK_TRANSITIONS[current] || []).includes(target);
}

// WhatsApp follow-up: a message drafted after a call never reaches the guest
// until a human approves it. The status is the approval, not a flag on a call.
const FOLLOWUP_DRAFT_STATUSES = ['draft', 'approved', 'sent', 'rejected', 'failed'];

const FOLLOWUP_DRAFT_TRANSITIONS = Object.freeze({
    draft: ['approved', 'rejected'],
    // Approval can be revoked while the message has not gone out yet.
    approved: ['sent', 'failed', 'rejected', 'draft'],
    // A delivery failure is recoverable: fix WhatsApp, approve again.
    failed: ['approved', 'rejected', 'draft'],
    rejected: ['draft'],
    // 'sent' is terminal: the guest already has the message.
    sent: [],
});

function normalizeFollowupDraftStatus(value, fallback = 'draft') {
    const status = String(value || '').trim().toLowerCase();
    return FOLLOWUP_DRAFT_STATUSES.includes(status) ? status : fallback;
}

function canTransitionFollowupDraft(from, to) {
    const current = normalizeFollowupDraftStatus(from, 'draft');
    const target = String(to || '').trim().toLowerCase();
    if (!FOLLOWUP_DRAFT_STATUSES.includes(target)) return false;
    if (current === target) return current !== 'sent';
    return (FOLLOWUP_DRAFT_TRANSITIONS[current] || []).includes(target);
}

// Manager-only by default. A business can opt into auto-send once its pilot
// has shown the drafts are safe; nothing else may bypass approval.
function followupAutoSendEnabled(instance = {}) {
    const raw = instance.followupAutoSendEnabled;
    if (raw === undefined || raw === null || raw === '') return false;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

module.exports = {
    VALID_STATUSES,
    BUSINESS_TYPES,
    STANDARD_STATUSES,
    COFFEE_STATUSES,
    FOLLOWUP_DRAFT_STATUSES,
    FOLLOWUP_DRAFT_TRANSITIONS,
    normalizeFollowupDraftStatus,
    canTransitionFollowupDraft,
    followupAutoSendEnabled,
    MANAGER_TASK_STATUSES,
    MANAGER_TASK_TRANSITIONS,
    MANAGER_TASK_REASONS,
    MANAGER_TASK_PRIORITIES,
    resolveBusinessType,
    getStatusesForBusiness,
    normalizeManagerTaskStatus,
    normalizeManagerTaskReason,
    normalizeManagerTaskPriority,
    canTransitionManagerTask
};
