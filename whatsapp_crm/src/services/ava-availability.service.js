'use strict';
const DB = require('./database.service');
const Sales = require('./sales-workspace.service');
const Identity = require('./identity/identity-store');
const PolicyStore = require('./ava-autopilot.store');
const initialized = new WeakSet();
const statuses = ['available', 'break', 'off'];

function fail(code, statusCode = 400) {
    throw Object.assign(new Error(code), {code, statusCode});
}

function ensureSchema() {
    if (!DB.db?.open) fail('AVAILABILITY_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    Identity.ensureSchema();
    DB.db.transaction(() => DB.db.exec(`
        CREATE TABLE IF NOT EXISTS ava_member_availability (
            businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            userId TEXT NOT NULL REFERENCES ava_users(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK(status IN ('available','break','off')),
            capacity INTEGER CHECK(capacity IS NULL OR (typeof(capacity)='integer' AND capacity>0)),
            revision INTEGER NOT NULL CHECK(revision>0),
            membershipCreatedAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            PRIMARY KEY(businessId,userId)
        );
        CREATE TRIGGER IF NOT EXISTS ava_availability_membership_removed
        AFTER DELETE ON ava_business_memberships BEGIN
            DELETE FROM ava_member_availability WHERE businessId=OLD.businessId AND userId=OLD.userId;
        END;
        CREATE TRIGGER IF NOT EXISTS ava_availability_membership_changed
        AFTER UPDATE OF enabled,role,createdAt ON ava_business_memberships
        WHEN NEW.enabled<>1 OR NEW.role NOT IN ('hotel_owner','sales_lead','manager') OR NEW.createdAt<>OLD.createdAt
        BEGIN
            DELETE FROM ava_member_availability WHERE businessId=OLD.businessId AND userId=OLD.userId;
        END;
        CREATE TRIGGER IF NOT EXISTS ava_availability_user_disabled
        AFTER UPDATE OF enabled ON ava_users WHEN NEW.enabled<>1 BEGIN
            DELETE FROM ava_member_availability WHERE userId=OLD.id;
        END;
    `)).immediate();
    initialized.add(DB.db);
}

function flagsService() {
    try { return require('./ava-improvements-flags.service'); }
    catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' && error.message.includes("'./ava-improvements-flags.service'")) return null;
        throw error;
    }
}

function authorize(auth, businessId, capability = 'sales.read') {
    if (auth?.platformRole === 'platform_admin') fail('BUSINESS_ACCESS_DENIED', 403);
    const actor = Sales.authorize(auth, businessId, capability);
    const flags = flagsService();
    if (!flags) fail('WORKSPACE_FEATURE_DISABLED', 409);
    flags.assertEnabled(actor.businessId, 'shifts');
    ensureSchema();
    return actor;
}

function memberRows(businessId) {
    return DB.all(`
        SELECT u.id AS userId,u.displayName AS name,m.createdAt AS membershipCreatedAt,
            a.status,a.capacity,a.revision,
            (SELECT COUNT(*) FROM clients c WHERE c.instanceId=m.businessId AND c.assigneeUserId=u.id
                AND (c.leadStatus IS NULL OR c.leadStatus NOT IN ('won','lost','junk','booked'))) AS currentLoad
        FROM ava_business_memberships m
        JOIN ava_users u ON u.id=m.userId AND u.enabled=1
        JOIN instances i ON i.id=m.businessId AND i.isActive=1
        LEFT JOIN ava_member_availability a ON a.businessId=m.businessId AND a.userId=m.userId
            AND a.membershipCreatedAt=m.createdAt
        WHERE m.businessId=? AND m.enabled=1 AND m.role IN ('hotel_owner','sales_lead','manager')
        ORDER BY u.displayName,u.id
    `, [businessId]).map(row => ({
        userId:row.userId, name:row.name, status:row.status || 'available', capacity:row.capacity ?? null,
        currentLoad:row.currentLoad, revision:row.revision || 0, configured:row.revision != null,
    }));
}

function list(auth, businessId) {
    return DB.db.transaction(() => {
        const actor = authorize(auth, businessId);
        return {success:true, businessId:actor.businessId, members:memberRows(actor.businessId)};
    })();
}

function validatePatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['revision', 'status', 'capacity'].includes(key))
        || !Number.isSafeInteger(body.revision) || body.revision < 0
        || (!Object.hasOwn(body, 'status') && !Object.hasOwn(body, 'capacity')))
        fail('AVAILABILITY_INPUT_INVALID');
    if (Object.hasOwn(body, 'status') && !statuses.includes(body.status)) fail('AVAILABILITY_INPUT_INVALID');
    if (Object.hasOwn(body, 'capacity') && body.capacity !== null
        && (!Number.isSafeInteger(body.capacity) || body.capacity < 1)) fail('AVAILABILITY_INPUT_INVALID');
}

function patch(auth, businessId, userId, body) {
    // Permission and revision are read after the write lock is acquired.
    return DB.db.transaction(() => {
        const actor = authorize(auth, businessId, 'sales.write');
        validatePatch(body);
        if (typeof userId !== 'string' || !userId || userId.length > 200) fail('AVAILABILITY_INPUT_INVALID');
        const teamEditor = ['hotel_owner', 'sales_lead'].includes(actor.role);
        if (!teamEditor && (actor.role !== 'manager' || userId !== actor.userId || Object.hasOwn(body, 'capacity')))
            fail('CAPABILITY_DENIED', 403);
        const member = memberRows(actor.businessId).find(row => row.userId === userId);
        if (!member) fail('AVAILABILITY_MEMBER_NOT_FOUND', 404);
        if (body.revision !== member.revision) fail('AVAILABILITY_REVISION_CONFLICT', 409);
        const membership = DB.get('SELECT createdAt FROM ava_business_memberships WHERE businessId=? AND userId=?',
            [actor.businessId, userId]);
        DB.run(`INSERT INTO ava_member_availability(businessId,userId,status,capacity,revision,membershipCreatedAt,updatedAt)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(businessId,userId) DO UPDATE SET status=excluded.status,
            capacity=excluded.capacity,revision=excluded.revision,membershipCreatedAt=excluded.membershipCreatedAt,
            updatedAt=excluded.updatedAt`, [actor.businessId, userId, body.status ?? member.status,
            Object.hasOwn(body, 'capacity') ? body.capacity : member.capacity, member.revision + 1,
            membership.createdAt, new Date().toISOString()]);
        return {success:true, businessId:actor.businessId, member:memberRows(actor.businessId).find(row => row.userId === userId)};
    }).immediate();
}

function inHours(policy, now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone:policy.timezone, weekday:'short', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
    }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const day = {Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7}[parts.weekday];
    const days = policy.workDays || [1, 2, 3, 4, 5, 6, 7];
    const {start, end} = policy.workHours;
    const time = parts.hour + ':' + parts.minute;
    if (start === end) return days.includes(day);
    if (start < end) return days.includes(day) && time >= start && time < end;
    // An overnight window belongs to its starting weekday, including after local midnight.
    return (time >= start && days.includes(day))
        || (time < end && days.includes(day === 1 ? 7 : day - 1));
}

function routingSnapshot(businessId, {now = new Date()} = {}) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) fail('BUSINESS_SCOPE_REQUIRED');
    const flags = flagsService();
    const enabled = Boolean(flags?.snapshot(id)?.flags?.shifts);
    // A caller-provided draft/stale policy must never activate configured routing.
    const policy = PolicyStore.policy(id);
    const routingEnabled = Boolean(policy?.enabled && policy.state === 'published' && policy.routing?.enabled);
    const withinHours = !enabled || !routingEnabled || inHours(policy, now);
    ensureSchema();
    DB.createSalesWorkspaceTables();
    const ids = new Set(policy?.routing?.memberIds || []);
    const members = memberRows(id).filter(member => ids.has(member.userId));
    const eligibleMembers = members.filter(member => !enabled || !routingEnabled || !member.configured
        || (withinHours && member.status === 'available' && (member.capacity === null || member.currentLoad < member.capacity)));
    const state = !enabled || !routingEnabled ? 'disabled' : eligibleMembers.length ? 'available'
        : !withinHours && members.some(member => member.configured) ? 'outside_hours' : 'no_available_members';
    return {businessId:id, enabled, routingEnabled, withinHours, members, eligibleMembers, state};
}

function routingAvailability(businessId, {now = new Date()} = {}) {
    const snapshot = routingSnapshot(businessId, {now});
    return {eligibleUserIds:snapshot.eligibleMembers.map(member => member.userId),
        configured:snapshot.enabled && snapshot.routingEnabled, isWorkingTime:snapshot.withinHours};
}

module.exports = {ensureSchema, authorize, list, patch, inHours, routingSnapshot, routingAvailability};
