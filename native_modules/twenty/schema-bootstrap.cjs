'use strict';

// Applies the checked-in AVA CRM manifest through Twenty Community metadata
// services. No SQL metadata writes, HTTP credentials, or Enterprise code.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const STANDARD_SINGULAR = Object.freeze({ people:'person', companies:'company', opportunities:'opportunity', tasks:'task', notes:'note' });
function loadManifest() { const local=path.join(__dirname,'schema-manifest.json'), source=path.join(__dirname,'../../whatsapp_crm/src/services/twenty/schema-manifest.json'), file=fs.existsSync(local)?local:source; return JSON.parse(fs.readFileSync(file,'utf8')); }

function stableUuid(value) {
  const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function validateContext(context, customApplication, standardApplication) {
  if (!context || !UUID.test(context.deploymentId || '') || !UUID.test(context.nativeScope || '') ||
      !Number.isSafeInteger(context.businessId) || context.businessId < 1 ||
      !Number.isSafeInteger(context.revision) || context.revision < 1 || context.disabled === true ||
      !UUID.test(customApplication?.id || '') || !customApplication.universalIdentifier ||
      !UUID.test(standardApplication?.id || '') || !standardApplication.universalIdentifier ||
      customApplication.id === standardApplication.id) throw fail('AVA_SCHEMA_SCOPE_INVALID');
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== '1.2' || manifest.twenty_release !== 'v2.37.0' ||
      !Array.isArray(manifest.custom_objects) || !manifest.field_definitions ||
      !manifest.standard_object_fields || !Array.isArray(manifest.standard_objects)) throw fail('AVA_SCHEMA_MANIFEST_INVALID');
  const objectNames = new Set(), pairs = new Set();
  for (const object of manifest.custom_objects) {
    if (!object?.nameSingular || !object.namePlural || !object.labelSingular || !object.labelPlural ||
        !Array.isArray(object.fields) || objectNames.has(object.nameSingular) || objectNames.has(object.namePlural)) throw fail('AVA_SCHEMA_MANIFEST_INVALID');
    objectNames.add(object.nameSingular); objectNames.add(object.namePlural);
    for (const name of object.fields) {
      if (!manifest.field_definitions[name] || pairs.has(`${object.namePlural}:${name}`)) throw fail('AVA_SCHEMA_MANIFEST_INVALID');
      pairs.add(`${object.namePlural}:${name}`);
    }
  }
  for (const [plural, fields] of Object.entries(manifest.standard_object_fields)) {
    if (!STANDARD_SINGULAR[plural] || !manifest.standard_objects.includes(plural) || !Array.isArray(fields)) throw fail('AVA_SCHEMA_MANIFEST_INVALID');
    for (const name of fields) if (!manifest.field_definitions[name] || pairs.has(`${plural}:${name}`)) throw fail('AVA_SCHEMA_MANIFEST_INVALID'); else pairs.add(`${plural}:${name}`);
  }
  for (const definition of Object.values(manifest.field_definitions)) {
    if (!definition?.label || !['TEXT','NUMBER','DATE','DATE_TIME'].includes(definition.type)) throw fail('AVA_SCHEMA_MANIFEST_INVALID');
  }
  return manifest;
}

function objectUid(context, app, name) { return stableUuid(`ava-schema:${context.deploymentId}:${context.businessId}:${app.universalIdentifier}:object:${name}`); }
function fieldUid(context, app, objectName, fieldName) { return stableUuid(`ava-schema:${context.deploymentId}:${context.businessId}:${app.universalIdentifier}:field:${objectName}:${fieldName}`); }
function values(map) { return Object.values(map?.byUniversalIdentifier || {}).filter(Boolean); }
async function snapshot(cache, workspaceId) { return cache.getOrRecomputeManyOrAllFlatEntityMaps({ workspaceId, flatMapsKeys:['flatObjectMetadataMaps','flatFieldMetadataMaps','flatIndexMaps'] }); }

function resolveStandard(objects, plural, standardApplication) {
  const singular = STANDARD_SINGULAR[plural];
  const matches = objects.filter(value => value.namePlural === plural || value.nameSingular === singular);
  if (matches.length !== 1 || matches[0].namePlural !== plural || matches[0].nameSingular !== singular ||
      matches[0].applicationId !== standardApplication.id || matches[0].isActive === false) throw fail('AVA_SCHEMA_STANDARD_OBJECT_INVALID');
  return matches[0];
}

function resolveCustom(objects, spec, uid, customApplication) {
  const named = objects.filter(value => value.nameSingular === spec.nameSingular || value.namePlural === spec.namePlural);
  const identified = objects.filter(value => value.universalIdentifier === uid);
  const candidates = new Set([...named, ...identified]);
  if (candidates.size > 1) throw fail('AVA_SCHEMA_OBJECT_COLLISION');
  const object = [...candidates][0] || null;
  if (object && (object.universalIdentifier !== uid || object.applicationId !== customApplication.id ||
      object.nameSingular !== spec.nameSingular || object.namePlural !== spec.namePlural ||
      object.labelSingular !== spec.labelSingular || object.labelPlural !== spec.labelPlural || object.isActive === false)) throw fail('AVA_SCHEMA_OBJECT_COLLISION');
  return object;
}

function resolveField(fields, object, spec, uid, customApplication) {
  const relevant = fields.filter(value => value.objectMetadataId === object.id && (value.name === spec.name || value.universalIdentifier === uid));
  if (relevant.length > 1) throw fail('AVA_SCHEMA_FIELD_COLLISION');
  const field = relevant[0] || null;
  if (field && (field.name !== spec.name || field.universalIdentifier !== uid || field.applicationId !== customApplication.id ||
      String(field.type).toUpperCase() !== spec.type || field.label !== spec.label || field.isActive === false)) throw fail('AVA_SCHEMA_FIELD_COLLISION');
  return field;
}

async function prepare(context, deps) {
  const manifest = validateManifest(deps?.manifest || loadManifest());
  const required = ['objectMetadataService','fieldMetadataService','flatCache','customApplication','standardApplication'];
  if (required.some(name => !deps?.[name])) throw fail('AVA_SCHEMA_DEPENDENCY_MISSING');
  validateContext(context, deps.customApplication, deps.standardApplication);
  let maps = await snapshot(deps.flatCache, context.nativeScope), objects = values(maps.flatObjectMetadataMaps);
  const objectByPlural = new Map();

  for (const plural of Object.keys(manifest.standard_object_fields)) objectByPlural.set(plural, resolveStandard(objects, plural, deps.standardApplication));
  let objectsCreated = 0, fieldsCreated = 0;
  for (const spec of manifest.custom_objects) {
    const uid = objectUid(context, deps.customApplication, spec.nameSingular);
    let object = resolveCustom(objects, spec, uid, deps.customApplication);
    if (!object) {
      try {
        await deps.objectMetadataService.createOneObject({ workspaceId:context.nativeScope, ownerFlatApplication:deps.customApplication,
          createObjectInput:{ nameSingular:spec.nameSingular, namePlural:spec.namePlural, labelSingular:spec.labelSingular,
            labelPlural:spec.labelPlural, description:`Безопасная tenant-scoped проекция AVA: ${spec.labelPlural}`,
            icon:'IconHotelService', universalIdentifier:uid, applicationId:deps.customApplication.id } });
      } catch (error) {
        maps = await snapshot(deps.flatCache, context.nativeScope); objects = values(maps.flatObjectMetadataMaps);
        object = resolveCustom(objects, spec, uid, deps.customApplication); if (!object) throw error;
      }
      maps = await snapshot(deps.flatCache, context.nativeScope); objects = values(maps.flatObjectMetadataMaps);
      object = resolveCustom(objects, spec, uid, deps.customApplication); if (!object) throw fail('AVA_SCHEMA_OBJECT_READBACK_INVALID');
      objectsCreated++;
    }
    objectByPlural.set(spec.namePlural, object);
  }

  const plan = [];
  for (const [plural, names] of Object.entries(manifest.standard_object_fields)) for (const name of names) plan.push({ plural, name });
  for (const object of manifest.custom_objects) for (const name of object.fields) plan.push({ plural:object.namePlural, name });
  for (const item of plan) {
    const object = objectByPlural.get(item.plural), definition = manifest.field_definitions[item.name];
    if (!object || !definition) throw fail('AVA_SCHEMA_MANIFEST_INVALID');
    const uid = fieldUid(context, deps.customApplication, item.plural, item.name);
    let fields = values(maps.flatFieldMetadataMaps), field = resolveField(fields, object, { name:item.name, ...definition }, uid, deps.customApplication);
    if (!field) {
      try {
        await deps.fieldMetadataService.createOneField({ workspaceId:context.nativeScope, ownerFlatApplication:deps.customApplication,
          createFieldInput:{ objectMetadataId:object.id, name:item.name, label:definition.label, type:definition.type,
            description:'Синхронизируется из AVA; business scope проверяется на стороне AVA.', isNullable:true,
            universalIdentifier:uid, applicationId:deps.customApplication.id } });
      } catch (error) {
        maps = await snapshot(deps.flatCache, context.nativeScope); fields = values(maps.flatFieldMetadataMaps);
        field = resolveField(fields, object, { name:item.name, ...definition }, uid, deps.customApplication); if (!field) throw error;
      }
      maps = await snapshot(deps.flatCache, context.nativeScope); fields = values(maps.flatFieldMetadataMaps);
      field = resolveField(fields, object, { name:item.name, ...definition }, uid, deps.customApplication); if (!field) throw fail('AVA_SCHEMA_FIELD_READBACK_INVALID');
      fieldsCreated++;
    }
  }

  maps = await snapshot(deps.flatCache, context.nativeScope); objects = values(maps.flatObjectMetadataMaps); const fields = values(maps.flatFieldMetadataMaps);
  for (const spec of manifest.custom_objects) {
    const object = resolveCustom(objects, spec, objectUid(context,deps.customApplication,spec.nameSingular), deps.customApplication);
    if (!object) throw fail('AVA_SCHEMA_NOT_READY');
    for (const name of spec.fields) if (!resolveField(fields,object,{name,...manifest.field_definitions[name]},fieldUid(context,deps.customApplication,spec.namePlural,name),deps.customApplication)) throw fail('AVA_SCHEMA_NOT_READY');
  }
  for (const [plural,names] of Object.entries(manifest.standard_object_fields)) {
    const object=resolveStandard(objects,plural,deps.standardApplication);
    for (const name of names) if (!resolveField(fields,object,{name,...manifest.field_definitions[name]},fieldUid(context,deps.customApplication,plural,name),deps.customApplication)) throw fail('AVA_SCHEMA_NOT_READY');
  }
  return { ready:true, manifestVersion:manifest.version, customObjectCount:manifest.custom_objects.length,
    requiredFieldCount:plan.length, objectsCreated, fieldsCreated, applicationId:deps.customApplication.id };
}

async function prepareWithApp(app, context) {
  const root='/app/packages/twenty-server/dist', load=(file,name)=>require(path.join(root,file))[name];
  const applicationService=app.get(load('engine/core-modules/application/application.service.js','ApplicationService'));
  const applications=await applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow({workspaceId:context.nativeScope});
  return prepare(context,{ manifest:loadManifest(),
    objectMetadataService:app.get(load('engine/metadata-modules/object-metadata/object-metadata.service.js','ObjectMetadataService')),
    fieldMetadataService:app.get(load('engine/metadata-modules/field-metadata/services/field-metadata.service.js','FieldMetadataService')),
    flatCache:app.get(load('engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service.js','WorkspaceManyOrAllFlatEntityMapsCacheService')),
    customApplication:applications.workspaceCustomFlatApplication, standardApplication:applications.twentyStandardFlatApplication });
}

module.exports={ fieldUid, loadManifest, objectUid, prepare, prepareWithApp, resolveCustom, resolveField, stableUuid, validateManifest };
