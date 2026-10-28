'use strict';
const DB = require('./database.service');

// Authority is the exact stable ID in a live enabled business membership. The
// legacy assignee/managerId strings never participate in this projection.
const memberJoin = (alias, field, instance) => `LEFT JOIN ava_business_memberships am ON am.userId=${alias}.${field}
 AND am.businessId=${alias}.${instance} AND am.enabled=1 AND am.role IN ('hotel_owner','sales_lead','manager')
 LEFT JOIN ava_users au ON au.id=am.userId AND au.enabled=1`;
const assignment = `CASE WHEN au.id IS NOT NULL THEN au.id ELSE NULL END`;
function filter(view, actor) {
    if (view === 'mine') return {sql:` AND (${assignment})=?`, params:[actor]};
    if (view === 'queue') return {sql:` AND (${assignment}) IS NULL`, params:[]};
    // Overview shares the tenant read projection with team. Its availability
    // follows sales.read; assignment rights remain separate service checks.
    if (view === 'overview' || view === 'team') return {sql:'',params:[]};
    return {sql:'',params:[]};
}
function tasks(businessId, view='team', actor=null) {
    const f=filter(view,actor);
    return DB.all(`SELECT t.*,${assignment} AS effectiveAssigneeUserId,au.displayName AS assigneeName,
        c.senderName AS canonicalCustomerName,
        (SELECT d.draftId FROM followup_drafts d WHERE d.instanceId=t.instanceId AND d.managerTaskId=t.taskId
          AND d.status NOT IN ('sent','rejected') ORDER BY d.createdAt DESC,d.draftId LIMIT 1) AS followupDraftId
        FROM manager_tasks t ${memberJoin('t','assigneeUserId','instanceId')}
        LEFT JOIN clients c ON c.instanceId=t.instanceId AND c.chatId=t.chatId
        WHERE t.instanceId=? AND t.status IN ('new','in_progress') ${f.sql}
        ORDER BY CASE WHEN t.dueAt IS NULL THEN 1 ELSE 0 END,julianday(t.dueAt),t.createdAt,t.taskId`,[businessId,...f.params]);
}
function clients(businessId, view='team', actor=null) {
    const f=filter(view,actor);
    return DB.all(`SELECT c.*,${assignment} AS effectiveAssigneeUserId,au.displayName AS assigneeName
        FROM clients c ${memberJoin('c','assigneeUserId','instanceId')}
        WHERE c.instanceId=? ${f.sql}
        ORDER BY julianday(c.lastMessageTime) DESC,c.chatId`,[businessId,...f.params]);
}
function pendingFollowups(businessId,view,actor) {
    const f=filter(view,actor);
    return DB.get(`SELECT COUNT(*) AS n FROM (
        SELECT d.*,COALESCE(CASE WHEN t.taskId IS NOT NULL THEN t.assigneeUserId ELSE c.assigneeUserId END,NULL) AS ownerId
        FROM followup_drafts d LEFT JOIN manager_tasks t ON t.instanceId=d.instanceId AND t.taskId=d.managerTaskId
        LEFT JOIN clients c ON c.instanceId=d.instanceId AND c.chatId=d.chatId
        WHERE d.instanceId=? AND d.status NOT IN ('sent','rejected')
    ) d ${memberJoin('d','ownerId','instanceId')} WHERE 1=1 ${f.sql}`,[businessId,...f.params]).n;
}
function task(businessId, taskId) { return DB.get('SELECT * FROM manager_tasks WHERE instanceId=? AND taskId=?',[businessId,taskId]); }
function drafts(businessId,{taskId,chatId}) {
    const clauses=[],params=[businessId];
    if(taskId) { clauses.push('managerTaskId=?');params.push(taskId); }
    if(chatId) { clauses.push(`chatId=? OR customerId IN (SELECT 'crm_' || instanceId || '_' || id FROM clients WHERE instanceId=? AND chatId=?)
            OR managerTaskId IN (SELECT taskId FROM manager_tasks WHERE instanceId=? AND chatId=?)`);params.push(chatId,businessId,chatId,businessId,chatId); }
    if(!clauses.length) return [];
    return DB.all(`SELECT * FROM followup_drafts WHERE instanceId=? AND (${clauses.join(' OR ')})`,params);
}
module.exports={tasks,clients,pendingFollowups,task,drafts};
