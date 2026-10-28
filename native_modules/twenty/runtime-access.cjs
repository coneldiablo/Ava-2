'use strict';

// A separate service-request authorization layer. It does not weaken the
// browser guard and never accepts caller-supplied "trusted peer" assertions.
// ava-sync-lease-v1 safety contract:
// - acquire authenticates this native process over a private peer channel and
//   binds the current outbox row to method/path/object/record/bodyDigest;
// - disable first closes lease issuance, then waits for completed/failed;
// - expiresAt is admission freshness, NEVER permission to drop a live barrier;
// - abandoned/expired/no-response leases fence and terminate the exact native
//   process incarnation (bounded graceful stop then forced kill, with death
//   proof) before broker disable may clear the barrier. A fake TTL release is
//   forbidden because an HTTP disconnect does not cancel a native DB write.
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { REQUIRED_OBJECTS } = require('./crm-bootstrap.cjs');
const { roleLabel } = require('./runtime-key.cjs');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTRACT='ava-sync-lease-v1';
const ALLOWED_OBJECTS=new Set(['people','companies','tasks','avaCalls','avaCampaigns','avaCampaignMembers','avaCallAttempts','avaFollowUpDrafts','avaBookingRequests']);
const fail=(code,status=403)=>Object.assign(new Error(code),{code,status});
const records=result=>Array.isArray(result)&&result.length===2&&Array.isArray(result[0])&&Number.isInteger(result[1])?result[0]:Array.isArray(result)?result:result?.records||[];

function ledgerFor(dataSource){return{async current(deploymentId){const rows=records(await dataSource.query(`SELECT deployment_id,workspace_id,revision,disabled,role_id,active_key_id,active_generation,active_expires_at
  FROM public.ava_runtime_key WHERE deployment_id=$1`,[deploymentId]));if(rows.length!==1)return null;const r=rows[0];return{deploymentId:r.deployment_id,workspaceId:r.workspace_id,revision:Number(r.revision),disabled:r.disabled,roleId:r.role_id,activeKeyId:r.active_key_id,activeGeneration:Number(r.active_generation),activeExpiresAt:r.active_expires_at};}};}
function validateContext(c,app){if(!c||!UUID.test(c.deploymentId||'')||!UUID.test(c.nativeScope||'')||!Number.isSafeInteger(c.businessId)||c.businessId<1||!Number.isSafeInteger(c.revision)||c.revision<1||c.disabled===true||!UUID.test(app?.id||''))throw fail('AVA_RUNTIME_ACCESS_SCOPE_INVALID',503);}
function currentRow(row,c,now=Date.now()){return Boolean(row&&row.deploymentId===c.deploymentId&&row.workspaceId===c.nativeScope&&row.revision===c.revision&&row.disabled===false&&UUID.test(row.roleId||'')&&UUID.test(row.activeKeyId||'')&&Number.isSafeInteger(row.activeGeneration)&&row.activeGeneration>0&&new Date(row.activeExpiresAt).getTime()>now);}
function canonical(value,depth=0){if(depth>8)throw fail('AVA_RUNTIME_ACCESS_BODY_INVALID',400);if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(v=>canonical(v,depth+1)).join(',')}]`;if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){const keys=Object.keys(value).sort();return`{${keys.map(k=>`${JSON.stringify(k)}:${canonical(value[k],depth+1)}`).join(',')}}`;}throw fail('AVA_RUNTIME_ACCESS_BODY_INVALID',400);}
function parseRequest(request){if(request.headers?.origin||request.headers?.cookie||request.headers?.['sec-fetch-site'])throw fail('AVA_RUNTIME_ACCESS_BROWSER_FORBIDDEN');const auth=request.headers?.authorization;if(typeof auth!=='string')throw fail('AVA_RUNTIME_ACCESS_TOKEN_REQUIRED',401);const match=/^Bearer ([A-Za-z0-9._~-]+)$/.exec(auth);if(!match||match[1].length>16384)throw fail('AVA_RUNTIME_ACCESS_TOKEN_REQUIRED',401);const method=String(request.method||'').toUpperCase();let url;try{url=new URL(request.originalUrl||request.url||request.path,'http://ava.invalid');}catch{throw fail('AVA_RUNTIME_ACCESS_ROUTE_FORBIDDEN');}const parts=url.pathname.split('/').filter(Boolean);if(parts.length<2||parts[0]!=='rest'||!ALLOWED_OBJECTS.has(parts[1])||url.search)throw fail('AVA_RUNTIME_ACCESS_ROUTE_FORBIDDEN');const objectName=parts[1],recordId=parts[2];if(parts.length>3||(method==='POST'&&recordId)||(method==='PATCH'&&(!recordId||!UUID.test(recordId)))||(method==='GET'&&(!recordId||!UUID.test(recordId)))||!['GET','POST','PATCH'].includes(method))throw fail('AVA_RUNTIME_ACCESS_ROUTE_FORBIDDEN');let bodyDigest=null;if(method==='POST'||method==='PATCH'){if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers?.['content-type']||'')||!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw fail('AVA_RUNTIME_ACCESS_BODY_INVALID',400);const serialized=canonical(request.body);if(Buffer.byteLength(serialized)>65536)throw fail('AVA_RUNTIME_ACCESS_BODY_INVALID',400);bodyDigest=crypto.createHash('sha256').update(serialized).digest('hex');}const correlationId=request.headers?.['x-correlation-id'];if(typeof correlationId!=='string'||(!UUID.test(correlationId)&&!/^twout_[0-9a-f-]{32,36}$/i.test(correlationId)))throw fail('AVA_RUNTIME_ACCESS_CORRELATION_REQUIRED');return{token:match[1],method,path:url.pathname,objectName,recordId:recordId||null,bodyDigest,correlationId};}
function safeRole(role,c,app){return Boolean(role&&role.id&&role.label===roleLabel(c.deploymentId)&&role.applicationId===app.id&&!role.canUpdateAllSettings&&!role.canAccessAllTools&&!role.canReadAllObjectRecords&&!role.canUpdateAllObjectRecords&&!role.canSoftDeleteAllObjectRecords&&!role.canDestroyAllObjectRecords&&role.canBeAssignedToUsers===false&&role.canBeAssignedToAgents===false&&role.canBeAssignedToApiKeys===true&&!(role.rolePermissionFlags||[]).length&&!(role.fieldPermissions||[]).length);}
function permissionsValid(role,objects){const matched=REQUIRED_OBJECTS.map(name=>objects.filter(v=>v.nameSingular===name));if(matched.some(group=>group.length!==1))return false;const wanted=new Set(matched.map(group=>group[0].id));if(wanted.size!==REQUIRED_OBJECTS.length||(role.objectPermissions||[]).length!==wanted.size)return false;return(role.objectPermissions||[]).every(p=>wanted.has(p.objectMetadataId)&&p.canReadObjectRecords===true&&p.canUpdateObjectRecords===true&&p.canSoftDeleteObjectRecords===false&&p.canDestroyObjectRecords===false);}
function exactLease(lease,claim,now){return Boolean(lease&&lease.authorized===true&&lease.contractVersion===CONTRACT&&UUID.test(lease.leaseId||'')&&Number.isSafeInteger(lease.expiresAt)&&lease.expiresAt>now+5000&&lease.expiresAt<=now+60000&&['deploymentId','businessId','nativeScope','revision','nativeKeyId','generation','roleId','correlationId','method','path','objectName','recordId','bodyDigest'].every(k=>lease[k]===claim[k]));}

function createRuntimeAccess(context,deps){const required=['jwtWrapperService','apiKeyService','apiKeyRoleService','roleService','flatCache','ownerFlatApplication','ledger','serviceAuthorization'];for(const name of required)if(!deps?.[name])throw fail('AVA_RUNTIME_ACCESS_DEPENDENCY_MISSING',500);if(deps.serviceAuthorization.contractVersion!==CONTRACT||typeof deps.serviceAuthorization.acquire!=='function'||typeof deps.serviceAuthorization.release!=='function'||typeof deps.serviceAuthorization.readback!=='function')throw fail('AVA_RUNTIME_ACCESS_BROKER_CONTRACT_MISSING',503);validateContext(context,deps.ownerFlatApplication);const now=deps.now||(()=>Date.now());
 async function authorize(request){const parsed=parseRequest(request);if((parsed.method==='POST'||parsed.method==='PATCH')&&request.body.avaBusinessId!=null&&String(request.body.avaBusinessId)!==String(context.businessId))throw fail('AVA_RUNTIME_ACCESS_BUSINESS_MISMATCH');let payload;try{payload=await deps.jwtWrapperService.verifyJwtToken(parsed.token);}catch{throw fail('AVA_RUNTIME_ACCESS_TOKEN_INVALID',401);}let row=await deps.ledger.current(context.deploymentId);if(!currentRow(row,context,now())||payload?.type!=='API_KEY'||payload?.jti!==row.activeKeyId||payload?.sub!==context.nativeScope||payload?.workspaceId!==context.nativeScope)throw fail('AVA_RUNTIME_ACCESS_FENCED');let key;try{key=await deps.apiKeyService.validateApiKey(payload.jti,context.nativeScope);}catch{throw fail('AVA_RUNTIME_ACCESS_TOKEN_INVALID',401);}const keyExpiresAt=new Date(key?.expiresAt).getTime();if(key?.id!==row.activeKeyId||key.workspaceId!==context.nativeScope||key.revokedAt!=null||!Number.isFinite(keyExpiresAt)||keyExpiresAt<=now())throw fail('AVA_RUNTIME_ACCESS_FENCED');const roleId=await deps.apiKeyRoleService.getRoleIdForApiKeyId(key.id,context.nativeScope);if(roleId!==row.roleId)throw fail('AVA_RUNTIME_ACCESS_ROLE_INVALID');const role=await deps.roleService.getRoleById(roleId,context.nativeScope);const maps=await deps.flatCache.getOrRecomputeManyOrAllFlatEntityMaps({workspaceId:context.nativeScope,flatMapsKeys:['flatObjectMetadataMaps']});const objects=Object.values(maps.flatObjectMetadataMaps.byUniversalIdentifier).filter(Boolean);if(!safeRole(role,context,deps.ownerFlatApplication)||!permissionsValid(role,objects))throw fail('AVA_RUNTIME_ACCESS_ROLE_INVALID');
  const claim={contractVersion:CONTRACT,deploymentId:context.deploymentId,businessId:context.businessId,nativeScope:context.nativeScope,revision:context.revision,nativeKeyId:key.id,generation:row.activeGeneration,roleId,correlationId:parsed.correlationId,method:parsed.method,path:parsed.path,objectName:parsed.objectName,recordId:parsed.recordId,bodyDigest:parsed.bodyDigest};let lease;try{lease=await deps.serviceAuthorization.acquire(claim);}catch{throw fail('AVA_RUNTIME_ACCESS_SERVICE_DENIED');}if(!exactLease(lease,claim,now())){if(lease?.leaseId)await deps.serviceAuthorization.release({contractVersion:CONTRACT,leaseId:lease.leaseId,outcome:'denied'}).catch(()=>{});throw fail('AVA_RUNTIME_ACCESS_SERVICE_DENIED');}row=await deps.ledger.current(context.deploymentId);if(!currentRow(row,context,now())||row.activeKeyId!==claim.nativeKeyId||row.activeGeneration!==claim.generation||row.roleId!==claim.roleId){await deps.serviceAuthorization.release({contractVersion:CONTRACT,leaseId:lease.leaseId,outcome:'fenced'}).catch(()=>{});throw fail('AVA_RUNTIME_ACCESS_FENCED');}let released=false;return{lease,claim,async release(outcome='completed'){if(released)return;released=true;await deps.serviceAuthorization.release({contractVersion:CONTRACT,leaseId:lease.leaseId,outcome});}};}
 function middleware(){return async(request,response,next)=>{let granted;try{granted=await authorize(request);}catch(error){const code=/^AVA_RUNTIME_ACCESS_[A-Z_]+$/.test(error?.code||'')?error.code:'AVA_RUNTIME_ACCESS_UNAVAILABLE';return response.status(Number(error?.status)||503).set('Cache-Control','no-store').json({error:'runtime_access_denied',code});}let done=false;const release=outcome=>{if(done)return;done=true;void granted.release(outcome).catch(()=>{try{response.destroy();}catch{}});};response.once('finish',()=>release(response.statusCode<500?'completed':'failed'));response.once('close',()=>release(response.writableFinished?(response.statusCode<500?'completed':'failed'):'abandoned'));next();};}
 return{authorize,middleware};}

async function createWithApp(app,context,serviceAuthorization){const root='/app/packages/twenty-server/dist',load=(file,name)=>require(path.join(root,file))[name],applicationService=app.get(load('engine/core-modules/application/application.service.js','ApplicationService')),applications=await applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow({workspaceId:context.nativeScope}),DataSource=require('typeorm').DataSource;return createRuntimeAccess(context,{jwtWrapperService:app.get(load('engine/core-modules/jwt/services/jwt-wrapper.service.js','JwtWrapperService')),apiKeyService:app.get(load('engine/core-modules/api-key/services/api-key.service.js','ApiKeyService')),apiKeyRoleService:app.get(load('engine/core-modules/api-key/services/api-key-role.service.js','ApiKeyRoleService')),roleService:app.get(load('engine/metadata-modules/role/role.service.js','RoleService')),flatCache:app.get(load('engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service.js','WorkspaceManyOrAllFlatEntityMapsCacheService')),ownerFlatApplication:applications.workspaceCustomFlatApplication,ledger:ledgerFor(app.get(DataSource)),serviceAuthorization});}

function requestJson(url, { method = 'POST', headers = {}, body, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = typeof url === 'string' ? new URL(url) : url;
    const transport = target.protocol === 'https:' ? https : http;
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = transport.request(target, {
      method,
      timeout,
      headers: {
        'content-type': 'application/json',
        ...(data ? { 'content-length': data.length } : {}),
        ...headers,
      },
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) {
          res.destroy();
          reject(fail('AVA_RUNTIME_ACCESS_BROKER_OVERSIZED', 503));
        } else {
          chunks.push(chunk);
        }
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          if (text) parsed = JSON.parse(text);
        } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = fail(parsed?.error_code || 'AVA_RUNTIME_ACCESS_SERVICE_DENIED', res.statusCode);
          return reject(err);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(fail('AVA_RUNTIME_ACCESS_BROKER_INVALID_JSON', 503));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(fail('AVA_RUNTIME_ACCESS_BROKER_TIMEOUT', 504));
    });
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

function createBrokerServiceAuthorization({ origin, adapterId, peerSecret, client, timeout = 3000 } = {}) {
  const caller = client || (async (subpath, body) => {
    if (!origin) throw fail('AVA_RUNTIME_ACCESS_SCOPE_INVALID', 503);
    const base = new URL(origin);
    const secret = typeof peerSecret === 'function' ? peerSecret() : peerSecret;
    if (!/^[0-9a-f-]{36}$/i.test(adapterId || '')) throw fail('AVA_RUNTIME_ACCESS_SCOPE_INVALID', 503);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret || '')) throw fail('AVA_RUNTIME_ACCESS_TOKEN_INVALID', 401);
    const target = new URL(subpath, base);
    return requestJson(target, {
      method: 'POST',
      timeout,
      headers: {
        'x-ava-adapter-id': adapterId,
        'authorization': `Bearer ${secret}`,
      },
      body,
    });
  });
  return {
    contractVersion: CONTRACT,
    async acquire(claim) {
      return caller('/v1/sync-lease/acquire', claim);
    },
    async release(input) {
      return caller('/v1/sync-lease/release', input);
    },
    async readback(leaseId) {
      return caller('/v1/sync-readback', { contractVersion: CONTRACT, leaseId });
    },
  };
}

function createLocalServiceAuthorization(store, peerAuth) {
  if (!store || typeof store.acquireSyncLease !== 'function' || typeof store.releaseSyncLease !== 'function'
    || typeof store.getSyncReadback !== 'function') {
    throw fail('AVA_RUNTIME_ACCESS_BROKER_CONTRACT_MISSING', 503);
  }
  if (!peerAuth?.adapterId || !peerAuth?.peerSecret) throw fail('AVA_RUNTIME_ACCESS_SCOPE_INVALID', 503);
  return {
    contractVersion: CONTRACT,
    async acquire(claim) {
      return store.acquireSyncLease(claim, peerAuth);
    },
    async release(input) {
      return store.releaseSyncLease(input, peerAuth);
    },
    async readback(leaseId) {
      return store.getSyncReadback(leaseId, peerAuth);
    },
  };
}

module.exports={ALLOWED_OBJECTS,CONTRACT,canonical,createRuntimeAccess,createWithApp,exactLease,ledgerFor,parseRequest,permissionsValid,records,safeRole,createBrokerServiceAuthorization,createLocalServiceAuthorization,requestJson};
