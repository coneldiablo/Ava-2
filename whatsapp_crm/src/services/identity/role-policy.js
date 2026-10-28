
'use strict';
const reads=['business.read','team.read','sales.read'];
const policy=Object.freeze({
    hotel_owner:[...reads,'business.manage','team.manage','sales.write','sales.assign','tasks.claim','tasks.manage','messages.send','ai.use'],
    sales_lead:[...reads,'sales.write','sales.assign','tasks.claim','tasks.manage','messages.send','ai.use'],
    manager:[...reads,'sales.write','tasks.claim','messages.send','ai.use'],
    observer:[...reads],
});
const teamRoles=Object.freeze(['manager','sales_lead','observer']);
const labels={manager:'Менеджер',sales_lead:'Руководитель продаж',observer:'Наблюдатель'};
function capabilitiesForRole(role) { return [...(policy[role] || [])]; }
function roleOptions() { return teamRoles.map(role=>({role,label:labels[role],capabilities:capabilitiesForRole(role)})); }
module.exports={capabilitiesForRole,roleOptions,teamRoles};
