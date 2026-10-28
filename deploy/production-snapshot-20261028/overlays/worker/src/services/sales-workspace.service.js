'use strict';
const DB = require('./database.service');
const Identity = require('./identity/identity-store');
const Canonical = require('./client-identity.service');
const Store = require('./sales-workspace.store');
const {MANAGER_TASK_STATUSES,MANAGER_TASK_PRIORITIES,canTransitionManagerTask} = require('../utils/constants');
const activeRoles = new Set(['hotel_owner','sales_lead','manager']);
const pendingStates = new Set(['pending','sending','unknown','unknown_pending','unknown-pending','delivery_pending','delivery_unconfirmed','unconfirmed']);
function fail(code,statusCode=400) { throw Object.assign(new Error(code),{code,statusCode}); }
function ensureStorage() {
    if(!DB.db || typeof DB.createSalesWorkspaceTables!=='function') fail('SALES_WORKSPACE_UNAVAILABLE',503);
    Identity.ensureSchema();
    DB.createSalesWorkspaceTables();
}
function authorize(auth,businessId,capability='sales.read') {
    if(!auth?.userId) fail('ACCOUNT_NOT_ACTIVE',403);
    if(typeof Identity.authorizeCapability!=='function'||typeof Identity.capabilitiesForRole!=='function') fail('SALES_WORKSPACE_UNAVAILABLE',503);
    const id=Identity.authorizeCapability(auth,businessId,capability);
    const current=Identity.actor(auth.userId);
    const membership=current.memberships.find(m=>Number(m.businessId)===id);
    if(!membership) fail('BUSINESS_ACCESS_DENIED',403);
    ensureStorage();
    return {businessId:id,userId:current.userId,role:membership.role,capabilities:Identity.capabilitiesForRole(membership.role)};
}
function ensureActiveAssignee(businessId,userId) {
    if(userId===null) return null;
    if(typeof userId!=='string'||!userId||userId.length>200) fail('SALES_ASSIGNEE_INVALID');
    let current;
    try { current=Identity.actor(userId); } catch (_) { fail('SALES_ASSIGNEE_INVALID'); }
    const membership=current.memberships.find(m=>Number(m.businessId)===Number(businessId));
    if(!membership||!activeRoles.has(membership.role)) fail('SALES_ASSIGNEE_INVALID');
    return current.userId;
}
function effectiveAssignee(businessId,userId) {
    if(!userId) return null;
    try {return ensureActiveAssignee(businessId,userId);} catch(error) {
        if(error.code==='SALES_ASSIGNEE_INVALID') return null;
        throw error;
    }
}
function json(value) {
    try {const parsed=JSON.parse(value==null?'{}':value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;}catch(_){return null;}
}
function deliveryPending(draft) {
    const metadata=json(draft.metadataJson);
    return !metadata || pendingStates.has(String(draft.status||'').trim().toLowerCase())
        || pendingStates.has(String(metadata.delivery_status||'').trim().toLowerCase())
        || pendingStates.has(String(metadata.provider_status||'').trim().toLowerCase());
}
function assertDeliveryMutable(businessId,selector) {
    if(Store.drafts(businessId,selector).some(deliveryPending)) fail('SALES_DELIVERY_PENDING',409);
}
function clearReconciliation(businessId,selector) {
    for(const draft of Store.drafts(businessId,selector)) {
        const metadata=json(draft.metadataJson);
        if(metadata?.assignment_reconciliation_required && !deliveryPending(draft)) {
            delete metadata.assignment_reconciliation_required;delete metadata.assignment_reconciliation_reason;
            DB.run('UPDATE followup_drafts SET metadataJson=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND draftId=?',[JSON.stringify(metadata),businessId,draft.draftId]);
        }
    }
}
function time(value) {
    if(!value) return null;
    const text=String(value);
    const date=new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text)?text:text.replace(' ','T')+'Z');
    return Number.isFinite(date.getTime())?date.toISOString():null;
}
function dueAt(value) {
    if(value===null) return null;
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('SALES_INPUT_INVALID');
    const [year,month,day]=value.slice(0,10).split('-').map(Number);
    const d=new Date(Date.UTC(year,month-1,day));
    if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day||!Number.isFinite(Date.parse(value))) fail('SALES_INPUT_INVALID');
    return new Date(value).toISOString();
}
function text(value) {if(typeof value!=='string'||!value.trim()||value.length>800) fail('SALES_INPUT_INVALID');return value.trim();}
function priority(value) {if(!MANAGER_TASK_PRIORITIES.includes(value)) fail('SALES_INPUT_INVALID');return value;}
function validateKeys(body,keys) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k))) fail('SALES_INPUT_INVALID');
}
function integer(value,fallback,max=Number.MAX_SAFE_INTEGER) {
    if(value===undefined) return fallback;
    if(!/^\d+$/.test(String(value))) fail('SALES_INPUT_INVALID');
    const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max) fail('SALES_INPUT_INVALID');return n;
}
function memberName(businessId,userId) {
    if(!userId) return null;
    return DB.get(`SELECT u.displayName FROM ava_users u JOIN ava_business_memberships m ON m.userId=u.id
        WHERE u.id=? AND u.enabled=1 AND m.businessId=? AND m.enabled=1`,[userId,businessId])?.displayName||null;
}
function taskView(row) {
    const assignee=Object.hasOwn(row,'effectiveAssigneeUserId')?row.effectiveAssigneeUserId:effectiveAssignee(row.instanceId,row.assigneeUserId);
    return {taskId:row.taskId,chatId:row.chatId||null,customerName:row.canonicalCustomerName||row.customerName||null,
        summary:row.summary,status:row.status,priority:row.priority,dueAt:time(row.dueAt),assigneeUserId:assignee,
        assigneeName:assignee?(row.assigneeName??memberName(row.instanceId,assignee)):null,
        followupDraftId:row.followupDraftId??DB.get(`SELECT draftId FROM followup_drafts WHERE instanceId=? AND managerTaskId=?
            AND status NOT IN ('sent','rejected') ORDER BY createdAt DESC,draftId LIMIT 1`,[row.instanceId,row.taskId])?.draftId??null,
        createdAt:time(row.createdAt),updatedAt:time(row.updatedAt)};
}
function clientView(row) {
    const assignee=Object.hasOwn(row,'effectiveAssigneeUserId')?row.effectiveAssigneeUserId:effectiveAssignee(row.instanceId,row.assigneeUserId);
    return {chatId:row.chatId,name:row.senderName,status:row.leadStatus,assigneeUserId:assignee,
        assigneeName:assignee?(row.assigneeName??memberName(row.instanceId,assignee)):null,lastContactAt:time(row.lastMessageTime)};
}
function canonicalClient(businessId,chatId) {
    if(typeof chatId!=='string'||!chatId||chatId.length>300) fail('SALES_INPUT_INVALID');
    const id=Canonical.resolve(businessId,chatId);
    const row=DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?',[businessId,id]);
    if(!row) fail('SALES_CLIENT_NOT_FOUND',404);return row;
}
function workspace(auth,businessId,query={}) {
    return DB.db.transaction(()=> {
        const actor=authorize(auth,businessId);
        const view=query.view||(actor.role==='observer'?'overview':'mine');
        if(!['mine','queue','team','overview'].includes(view)) fail('SALES_INPUT_INVALID');
        if(view==='team'&&!['hotel_owner','sales_lead'].includes(actor.role)) fail('SALES_TEAM_VIEW_DENIED',403);
        const page=integer(query.page,1),pageSize=integer(query.pageSize,30,100),offset=(page-1)*pageSize;
        const rows=Store.tasks(actor.businessId,view,actor.userId),clients=Store.clients(actor.businessId,view,actor.userId);
        const allTasks=view==='team'?rows:Store.tasks(actor.businessId);
        const now=Date.now(),overdue=r=>r.dueAt&&Number.isFinite(Date.parse(time(r.dueAt)))&&Date.parse(time(r.dueAt))<now;
        const members=Identity.listBusinessTeam(auth,actor.businessId).members.map(member=> {
            const own=allTasks.filter(t=>t.effectiveAssigneeUserId===member.userId);
            return {userId:member.userId,displayName:member.displayName,email:member.email,role:member.role,openTasks:own.length,overdueTasks:own.filter(overdue).length};
        });
        return {success:true,businessId:actor.businessId,view,currentUserId:actor.userId,capabilities:actor.capabilities,
            summary:{openTasks:rows.length,overdueTasks:rows.filter(overdue).length,
                pendingFollowups:Store.pendingFollowups(actor.businessId,view,actor.userId),unassignedClients:clients.filter(c=>!c.effectiveAssigneeUserId).length},
            members,tasks:rows.slice(offset,offset+pageSize).map(taskView),clients:clients.slice(offset,offset+pageSize).map(clientView),
            pagination:{page,pageSize,totalTasks:rows.length,totalClients:clients.length}};
    })();
}
function authorizeTaskMutation(auth,businessId,taskId) {
    const actor=authorize(auth,businessId,'sales.write'),row=Store.task(actor.businessId,taskId);
    if(!row) fail('SALES_TASK_NOT_FOUND',404);
    if(!actor.capabilities.includes('tasks.manage')&&effectiveAssignee(actor.businessId,row.assigneeUserId)!==actor.userId) fail('SALES_TASK_SCOPE_DENIED',403);
    return {actor,row};
}
function authorizeClientMutation(auth,businessId,chatId,{capability='sales.write'}={}) {
    const actor=authorize(auth,businessId,capability),row=canonicalClient(actor.businessId,chatId);
    if(!actor.capabilities.includes('sales.assign')) {
        const assignee=effectiveAssignee(actor.businessId,row.assigneeUserId);
        if(!assignee) fail('SALES_CLIENT_CLAIM_REQUIRED',403);
        if(assignee!==actor.userId) fail('SALES_CLIENT_SCOPE_DENIED',403);
    }
    return {actor,row};
}
function createTask(auth,businessId,body) {
    validateKeys(body,['chatId','summary','dueAt','priority','assigneeUserId']);
    return DB.db.transaction(()=> {
        const actor=authorize(auth,businessId,'sales.write'),client=canonicalClient(actor.businessId,body.chatId);
        const target=Object.hasOwn(body,'assigneeUserId')?ensureActiveAssignee(actor.businessId,body.assigneeUserId):actor.userId;
        if(!actor.capabilities.includes('sales.assign')) {
            if(target!==actor.userId) fail('CAPABILITY_DENIED',403);
            const existing=effectiveAssignee(actor.businessId,client.assigneeUserId);
            if(existing&&existing!==actor.userId) fail('SALES_CLIENT_SCOPE_DENIED',403);
        }
        const row=DB.createManagerTask({instanceId:actor.businessId,chatId:client.chatId,customerId:`crm_${actor.businessId}_${client.id}`,
            customerName:client.senderName,summary:text(body.summary),priority:body.priority===undefined?'normal':priority(body.priority),
            dueAt:body.dueAt===undefined?null:dueAt(body.dueAt),assigneeUserId:target,assignee:target,
            createdByUserId:actor.userId,source:'sales_workspace',reason:'manual',status:'new'});
        if(!row) fail('SALES_WORKSPACE_UNAVAILABLE',503);
        return {success:true,businessId:actor.businessId,task:taskView(row)};
    }).immediate();
}
function updateTask(auth,businessId,taskId,body) {
    validateKeys(body,['status','dueAt','assigneeUserId','summary','priority']);
    if(!Object.keys(body).length) fail('SALES_INPUT_INVALID');
    return DB.db.transaction(()=> {
        const {actor,row}=authorizeTaskMutation(auth,businessId,taskId),patch={};
        if(Object.hasOwn(body,'assigneeUserId')) {
            const target=ensureActiveAssignee(actor.businessId,body.assigneeUserId);
            if(!actor.capabilities.includes('sales.assign')&&target!==actor.userId) fail('CAPABILITY_DENIED',403);
            if(target!==row.assigneeUserId) {
                assertDeliveryMutable(actor.businessId,{taskId:row.taskId});
                patch.assigneeUserId=target;patch.assignee=target;
                if(target) clearReconciliation(actor.businessId,{taskId:row.taskId});
            }
        }
        if(body.status!==undefined) {
            if(!MANAGER_TASK_STATUSES.includes(body.status)) fail('SALES_INPUT_INVALID');
            if(body.status!==row.status&&!canTransitionManagerTask(row.status,body.status)) fail('SALES_STATUS_TRANSITION',409);
            patch.status=body.status;
        }
        if(Object.hasOwn(body,'dueAt')) patch.dueAt=dueAt(body.dueAt);
        if(body.summary!==undefined) patch.summary=text(body.summary);
        if(body.priority!==undefined) patch.priority=priority(body.priority);
        const changed=DB.updateManagerTask(actor.businessId,taskId,patch);
        return {success:true,businessId:actor.businessId,task:taskView(changed)};
    }).immediate();
}
function claimTask(auth,businessId,taskId) {
    return DB.db.transaction(()=> {
        const actor=authorize(auth,businessId,'tasks.claim');
        ensureActiveAssignee(actor.businessId,actor.userId);
        const row=Store.task(actor.businessId,taskId);if(!row) fail('SALES_TASK_NOT_FOUND',404);
        if(!['new','in_progress'].includes(row.status)) fail('SALES_TASK_CLOSED',409);
        const current=effectiveAssignee(actor.businessId,row.assigneeUserId);
        if(current&&current!==actor.userId) fail('SALES_TASK_ASSIGNED',409);
        if(current===actor.userId) return {success:true,businessId:actor.businessId,task:taskView(row),idempotent:true};
        assertDeliveryMutable(actor.businessId,{taskId});
        const changed=DB.run(`UPDATE manager_tasks SET assigneeUserId=?,assignee=?,updatedAt=CURRENT_TIMESTAMP
            WHERE instanceId=? AND taskId=? AND assigneeUserId IS ?`,[actor.userId,actor.userId,actor.businessId,taskId,row.assigneeUserId]);
        if(changed.changes!==1) fail('SALES_TASK_ASSIGNED',409);
        clearReconciliation(actor.businessId,{taskId});
        return {success:true,businessId:actor.businessId,task:taskView(Store.task(actor.businessId,taskId)),idempotent:false};
    }).immediate();
}
function assignClient(auth,businessId,chatId,body) {
    validateKeys(body,['assigneeUserId']);if(!Object.hasOwn(body,'assigneeUserId')) fail('SALES_INPUT_INVALID');
    return DB.db.transaction(()=> {
        const actor=authorize(auth,businessId,'sales.write'),row=canonicalClient(actor.businessId,chatId);
        const target=ensureActiveAssignee(actor.businessId,body.assigneeUserId),current=effectiveAssignee(actor.businessId,row.assigneeUserId);
        if(!actor.capabilities.includes('sales.assign')) {
            if(target!==actor.userId) fail('CAPABILITY_DENIED',403);
            if(current&&current!==actor.userId) fail('SALES_CLIENT_ASSIGNED',409);
        }
        if(target===current&&target===row.assigneeUserId) return {success:true,businessId:actor.businessId,client:clientView(row),idempotent:true};
        assertDeliveryMutable(actor.businessId,{chatId:row.chatId});
        const changed=DB.run(`UPDATE clients SET assigneeUserId=?,updatedAt=CURRENT_TIMESTAMP
            WHERE instanceId=? AND chatId=? AND assigneeUserId IS ?`,[target,actor.businessId,row.chatId,row.assigneeUserId]);
        if(changed.changes!==1) fail('SALES_CLIENT_ASSIGNED',409);
        if(target) clearReconciliation(actor.businessId,{chatId:row.chatId});
        return {success:true,businessId:actor.businessId,client:clientView(canonicalClient(actor.businessId,row.chatId)),idempotent:false};
    }).immediate();
}
function cleanupMemberAssignments(businessId,userId,options={}) {
    if(!DB.db?.inTransaction) fail('SALES_CLEANUP_TRANSACTION_REQUIRED',503);
    ensureStorage();
    const affected=DB.all(`SELECT d.* FROM followup_drafts d WHERE d.instanceId=? AND (
        EXISTS(SELECT 1 FROM manager_tasks t WHERE t.instanceId=d.instanceId AND t.taskId=d.managerTaskId AND t.assigneeUserId=?)
        OR EXISTS(SELECT 1 FROM clients c WHERE c.instanceId=d.instanceId AND c.chatId=d.chatId AND c.assigneeUserId=?))`,[businessId,userId,userId]);
    let reconciliation=0;
    for(const draft of affected) if(deliveryPending(draft)) {
        const parsed=json(draft.metadataJson);
        const metadata={...(parsed||{}),...(!parsed?{assignment_reconciliation_original_metadata:draft.metadataJson}:{}),assignment_reconciliation_required:true,assignment_reconciliation_reason:options.reason||'membership_changed'};
        DB.run('UPDATE followup_drafts SET metadataJson=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND draftId=?',[JSON.stringify(metadata),businessId,draft.draftId]);
        reconciliation++;
    }
    const clients=DB.run('UPDATE clients SET assigneeUserId=NULL,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND assigneeUserId=?',[businessId,userId]).changes;
    const tasks=DB.run('UPDATE manager_tasks SET assigneeUserId=NULL,assignee=NULL,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND assigneeUserId=?',[businessId,userId]).changes;
    return {clients,tasks,reconciliation};
}
module.exports={authorize,workspace,createTask,updateTask,claimTask,assignClient,cleanupMemberAssignments,
    authorizeTaskMutation,authorizeClientMutation,ensureActiveAssignee,assertDeliveryMutable,deliveryPending,taskView};
