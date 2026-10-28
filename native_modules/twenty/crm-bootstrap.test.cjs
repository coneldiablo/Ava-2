'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { REQUIRED_OBJECTS, BASE_OBJECTS, provisionCrmPermissions } = require('./crm-bootstrap.cjs');
const ids = REQUIRED_OBJECTS.map((_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
function fixture() { const roles = new Map([['manager', { id:'manager', objectPermissions:[] }], ['owner', { id:'owner', objectPermissions:[] }]]); const calls=[]; return { calls, deps:{ findObjects:async (workspaceId,names)=>REQUIRED_OBJECTS.map((name,i)=>({nameSingular:name,id:ids[i]})).filter(item=>names.includes(item.nameSingular)), getRole:async id=>roles.get(id), objectPermissionService:{ upsertObjectPermissions:async ({input})=>{ calls.push(input); roles.get(input.roleId).objectPermissions=input.objectPermissions; } } } }; }
test('grants base CRM objects to both ordinary data roles and reports missing custom schema', async () => { const f=fixture(); const result=await provisionCrmPermissions({nativeScope:'workspace',managerRoleId:'manager',hotelOwnerRoleId:'owner'},f.deps); assert.equal(result.manager.objectCount, BASE_OBJECTS.length); assert.equal(f.calls.length,2); assert.ok(f.calls[0].objectPermissions.every(p=>p.canReadObjectRecords&&p.canUpdateObjectRecords&&!p.canDestroyObjectRecords)); assert.ok(f.calls[1].objectPermissions.every(p=>p.canReadObjectRecords&&p.canUpdateObjectRecords)); assert.equal(result.schemaComplete,true); });
test('fails closed on schema loss, unsafe role, or stale readback', async () => { const f=fixture(); f.deps.findObjects=async()=>[]; await assert.rejects(provisionCrmPermissions({nativeScope:'w',managerRoleId:'manager',hotelOwnerRoleId:'owner'},f.deps),{code:'AVA_CRM_SCHEMA_INCOMPLETE'}); const unsafe=fixture(); unsafe.deps.getRole=async()=>({canAccessAllTools:true}); await assert.rejects(provisionCrmPermissions({nativeScope:'w',managerRoleId:'manager',hotelOwnerRoleId:'owner'},unsafe.deps),{code:'AVA_CRM_ROLE_UNSAFE'}); });
test('full schema grants every manifest object but no delete or administration', async () => {
  const f = fixture();
  const result = await provisionCrmPermissions({ nativeScope:'w',managerRoleId:'manager',hotelOwnerRoleId:'owner' }, f.deps, { requireFullSchema:true });
  assert.equal(result.manager.objectCount, REQUIRED_OBJECTS.length);
  assert.equal(result.hotelOwner.objectCount, REQUIRED_OBJECTS.length);
  assert.equal(result.schemaComplete, true);
  assert.ok(f.calls.every(call => call.objectPermissions.every(p => p.canReadObjectRecords && p.canUpdateObjectRecords && !p.canSoftDeleteObjectRecords && !p.canDestroyObjectRecords)));
  const incomplete = fixture();
  incomplete.deps.findObjects = async (_workspace, names) => names.filter(name => name !== 'avaCall').map(name => ({ nameSingular:name,id:name }));
  await assert.rejects(provisionCrmPermissions({ nativeScope:'w',managerRoleId:'manager',hotelOwnerRoleId:'owner' }, incomplete.deps, { requireFullSchema:true }), { code:'AVA_CRM_SCHEMA_INCOMPLETE' });
});
