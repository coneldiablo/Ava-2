'use strict';
// Community ObjectPermissionService adapter. It grants no workspace/settings flags.
const REQUIRED_OBJECTS = Object.freeze(['person', 'company', 'task', 'note', 'avaCall', 'avaCampaign', 'avaCampaignMember', 'avaCallAttempt', 'avaFollowUpDraft', 'avaCustomerIdentity', 'avaBookingRequest']);
const BASE_OBJECTS = Object.freeze(['person', 'company', 'task', 'note']);
const fail = code => Object.assign(new Error(code), { code });
const safePermissions = writable => ({ canReadObjectRecords: true, canUpdateObjectRecords: writable, canSoftDeleteObjectRecords: false, canDestroyObjectRecords: false });
async function grantRolePermissions({ workspaceId, roleId, writable, names = REQUIRED_OBJECTS }, { findObjects, objectPermissionService, getRole }) {
  if (typeof workspaceId !== 'string' || typeof roleId !== 'string' || typeof writable !== 'boolean') throw fail('AVA_CRM_PERMISSION_INPUT_INVALID');
  const role = await getRole(roleId, workspaceId);
  if (!role || role.canUpdateAllSettings || role.canAccessAllTools || role.canBeAssignedToApiKeys || role.canBeAssignedToAgents) throw fail('AVA_CRM_ROLE_UNSAFE');
  const objects = await findObjects(workspaceId, names);
  if (!Array.isArray(objects) || objects.length !== names.length || new Set(objects.map(item => item.nameSingular)).size !== names.length) throw fail('AVA_CRM_SCHEMA_INCOMPLETE');
  const input = { roleId, objectPermissions: objects.map(object => ({ objectMetadataId: object.id, ...safePermissions(writable) })) };
  await objectPermissionService.upsertObjectPermissions({ workspaceId, input });
  const read = await getRole(roleId, workspaceId);
  const expected = new Map(input.objectPermissions.map(value => [value.objectMetadataId, value]));
  if (!read || (read.objectPermissions || []).length !== expected.size || (read.objectPermissions || []).some(value => { const wanted = expected.get(value.objectMetadataId); return !wanted || ['canReadObjectRecords','canUpdateObjectRecords','canSoftDeleteObjectRecords','canDestroyObjectRecords'].some(key => Boolean(value[key]) !== Boolean(wanted[key])); })) throw fail('AVA_CRM_PERMISSION_READBACK_INVALID');
  return { roleId, objectCount: expected.size, writable };
}
async function provisionCrmPermissions(context, deps, { requireFullSchema = false, names: requestedNames } = {}) {
  const names = requestedNames || (requireFullSchema ? REQUIRED_OBJECTS : BASE_OBJECTS);
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length || names.some(name => !REQUIRED_OBJECTS.includes(name))) {
    throw fail('AVA_CRM_PERMISSION_INPUT_INVALID');
  }
  const manager = await grantRolePermissions({ workspaceId: context.nativeScope, roleId: context.managerRoleId, writable: true, names }, deps);
  const hotelOwner = await grantRolePermissions({ workspaceId: context.nativeScope, roleId: context.hotelOwnerRoleId, writable: true, names }, deps);
  const present = await deps.findObjects(context.nativeScope, REQUIRED_OBJECTS);
  const missing = REQUIRED_OBJECTS.filter(name => !present.some(object => object.nameSingular === name));
  if (requireFullSchema && missing.length) throw fail('AVA_CRM_SCHEMA_INCOMPLETE');
  return { manager, hotelOwner, schemaComplete: missing.length === 0, missingObjects: missing };
}
module.exports = { REQUIRED_OBJECTS, BASE_OBJECTS, grantRolePermissions, provisionCrmPermissions };
