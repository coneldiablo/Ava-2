'use strict';
// Operator-only, real native probes. Never a public route or a boolean fixture.
// Mount only the explicitly prepared pilot directory and AVA SQLite; run on
// the private native network with the reviewed CRM image.
process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
process.umask(0o077);
const fs = require('node:fs');
const crypto = require('node:crypto');
const ROOT = '/run/ava-entry';
const Logger = require('/app/src/utils/logger');
for (const name of ['info','warn','error','debug','success']) Logger[name] = () => {};
const DB = require('/app/src/services/database.service');
const Access = require('/app/src/services/identity/module-access-store');
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
const key = name => fs.readFileSync(`${ROOT}/native-keys/${name}.key`, 'utf8').trim();
async function call(path, { body, method='POST', headers={}, peer='gateway', native=false }={}) {
    const response = await fetch(`http://native:${native ? 3000 : 3902}${path}`, {
        method, signal: AbortSignal.timeout(15000), headers: {
            'Content-Type':'application/json', ...(native ? {} : { Authorization:`Bearer ${key(peer)}` }), ...headers,
        }, ...(body === undefined ? {} : {body:JSON.stringify(body)}), redirect:'error',
    });
    return {status:response.status, data:await response.json().catch(()=>null)};
}
async function main() {
    check(['--qa','--owner','--foreign'].includes(process.argv[2]), 'EXPLICIT_PRINCIPAL_REQUIRED');
    const manifest = JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`));
    check(manifest.businessId===1 && manifest.nativeScope==='72600089-b4b4-4db3-a8b9-362f07033467'
        && manifest.mode==='existing_workspace_ui' && manifest.origin==='https://alleya-resort-1.crm.meludtech.tech', 'ENTRY_SCOPE_MISMATCH');
    const foreignFixture={businessId:900003,deploymentId:'0cd449d9-fd57-4010-ab84-25570ff7f84c',nativeScope:'190b2294-ba62-4e58-8bf6-155f4bd08788',revision:1};
    if(process.argv[2]==='--foreign'){
        const response=await fetch('http://ava-twenty-auth-qa-fc523183e455-serve:3902/v1/verify',{
            method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key('worker')}`},
            body:JSON.stringify({...foreignFixture,userId:'7a64e752-8bd7-4aa7-bbcf-adf1d0e8a018'}),signal:AbortSignal.timeout(15000),redirect:'error'});
        if(![401,403].includes(response.status)) console.log(JSON.stringify({foreignNativeProbeStatus:response.status}));
        check([401,403].includes(response.status),'FOREIGN_NATIVE_KEY_NOT_DENIED');
        fs.writeFileSync(`${ROOT}/foreign-proof.json`,JSON.stringify({sourceDeploymentId:manifest.deploymentId,...foreignFixture,status:response.status,verifiedAt:Date.now()}),{mode:0o600});
        console.log('FOREIGN_ACTIVE_NATIVE_KEY_DENIED');return;
    }
    const foreignProof=JSON.parse(fs.readFileSync(`${ROOT}/foreign-proof.json`));
    check(foreignProof.sourceDeploymentId===manifest.deploymentId&&foreignProof.nativeScope===foreignFixture.nativeScope
        &&[401,403].includes(foreignProof.status)&&Date.now()-foreignProof.verifiedAt<600000,'FOREIGN_NATIVE_PROOF_REQUIRED');
    await DB.init();
    let configured;
    const existing = DB.get("SELECT * FROM ava_module_adapters WHERE businessId=1 AND module='twenty'");
    if (!existing) {
        check(process.argv[2]==='--qa', 'QA_FIRST_REQUIRED');
        // Durable peer material and manifest are written before the outer
        // SQLite transaction commits. A interrupted pre-commit setup has no
        // active DB adapter, so only its own uncommitted journal is removable.
        const peerFile=`${ROOT}/gateway-keys/broker-peer`;
        if(fs.existsSync(peerFile)){
            check(manifest.enrollmentState==='prepared'&&manifest.adapterId,'ENTRY_ENROLLMENT_RECONCILIATION_REQUIRED');
            fs.unlinkSync(peerFile);
        }
        DB.db.transaction(()=>{
            configured=Access.configure({businessId:1,module:'twenty',publicOrigin:manifest.origin,
                attachmentMode:'existing_workspace_ui',expectedNativeScope:manifest.nativeScope,expectedIntegrationRevision:manifest.integrationRevision});
            const fd=fs.openSync(peerFile,'wx',0o600);
            try{fs.writeFileSync(fd,configured.peerSecret);fs.fchownSync(fd,1000,1000);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
            manifest.adapterId=configured.id;
            manifest.enrollmentState='prepared';
            const mfd=fs.openSync(`${ROOT}/manifest.json`,'w',0o600);
            try{fs.writeFileSync(mfd,JSON.stringify(manifest,null,2));fs.fsyncSync(mfd);}finally{fs.closeSync(mfd);}
        }).immediate();
    } else {
        check(existing.id===manifest.adapterId && existing.nativeScope===manifest.nativeScope
            && existing.attachmentMode==='existing_workspace_ui' && existing.enabled===1 && existing.revision===manifest.revision,
            'ENTRY_ADAPTER_CHANGED');
        check(crypto.createHash('sha256').update(fs.readFileSync(`${ROOT}/gateway-keys/broker-peer`,'utf8').trim()).digest('hex')===existing.peerSecretHash,'ENTRY_PEER_SECRET_MISMATCH');
        configured={id:existing.id};
    }
    const user = process.argv[2]==='--owner'
        ? DB.get('SELECT * FROM ava_users WHERE id=?',['7a64e752-8bd7-4aa7-bbcf-adf1d0e8a018'])
        : DB.get('SELECT * FROM ava_users WHERE email=?',[JSON.parse(fs.readFileSync(`${ROOT}/qa.private.json`)).email]);
    check(user?.enabled===1 && user.subject && user.platformRole==='customer','CUSTOMER_NOT_ACTIVE');
    const membership=DB.get('SELECT * FROM ava_business_memberships WHERE userId=? AND businessId=1 AND enabled=1',[user.id]);
    check(membership && ['hotel_owner','manager'].includes(membership.role),'CUSTOMER_SCOPE_INVALID');
    const common={businessId:1,deploymentId:manifest.deploymentId,nativeScope:manifest.nativeScope,revision:manifest.revision};
    const provision=await call('/v1/provision',{peer:'worker',body:{...common,userId:user.id,subject:user.subject,
        role:membership.role,email:`ava-${user.id}@native.ava.invalid`,displayName:user.displayName||'Пользователь AVA'}});
    check(provision.status===200 && provision.data?.userId===user.id,'NATIVE_PRINCIPAL_FAILED');
    const member=provision.data, bindingId=crypto.randomUUID();
    let minted=false;
    try {
        const session=await call('/v1/sessions/create',{body:{...common,bindingId,userId:user.id,subject:user.subject,
            nativeUserId:member.nativeUserId,role:membership.role,expiresAt:Date.now()+180000}});
        check(session.status===200 && session.data?.bindingId===bindingId,'NATIVE_PROOF_SESSION_FAILED');
        minted=true;
        const headers={Cookie:session.data.nativeCookie,Origin:manifest.origin,
            'x-ava-native-peer':key('gateway'),'x-ava-native-binding':bindingId};
        const query={query:'query EntryProof { currentUser { id } currentUserSessions { id workspaceId isCurrent } }'};
        await Access.verifyPrincipal({adapterId:configured.id,userId:user.id,nativeUserId:member.nativeUserId,readback:async input=>{
            const own=await call('/metadata',{native:true,headers,body:query});
            check(own.status===200&&!own.data?.errors?.length&&own.data?.data?.currentUser?.id===member.nativeUserId
                &&own.data.data.currentUserSessions.some(s=>s.id===session.data.nativeSessionId&&s.workspaceId===manifest.nativeScope&&s.isCurrent),'NATIVE_SESSION_READBACK_FAILED');
            const publicScope=await call('/metadata',{native:true,headers,body:{query:'query($origin:String!){getPublicWorkspaceDataByDomain(origin:$origin){id workspaceUrls{subdomainUrl customUrl}}}',variables:{origin:manifest.origin}}});
            if(publicScope.data?.errors?.length||publicScope.data?.data?.getPublicWorkspaceDataByDomain?.id!==manifest.nativeScope)
                console.log(JSON.stringify({publicScopeStatus:publicScope.status,errors:publicScope.data?.errors?.map(e=>({message:e.message,code:e.extensions?.code})),data:publicScope.data?.data}));
            check(publicScope.status===200&&!publicScope.data?.errors?.length&&publicScope.data?.data?.getPublicWorkspaceDataByDomain?.id===manifest.nativeScope
                &&publicScope.data.data.getPublicWorkspaceDataByDomain.workspaceUrls.subdomainUrl===manifest.origin,'NATIVE_UI_SCOPE_FAILED');
            const records=await call('/rest/people?limit=1',{native:true,method:'GET',headers});
            check(records.status===200&&!records.data?.errors?.length,'NATIVE_CRM_RECORD_ACCESS_FAILED');
            const foreign=await call('/v1/verify',{peer:'worker',body:{...foreignFixture,userId:user.id}});
            const workspaceQuery='query($id:UUID!){getPublicWorkspaceDataById(id:$id){id}}';
            const ownWorkspace=await call('/metadata',{native:true,headers,body:{query:workspaceQuery,variables:{id:manifest.nativeScope}}});
            check(ownWorkspace.status===200&&!ownWorkspace.data?.errors?.length&&ownWorkspace.data?.data?.getPublicWorkspaceDataById?.id===manifest.nativeScope,'NATIVE_WORKSPACE_ID_READBACK_FAILED');
            const foreignWorkspace=await call('/metadata',{native:true,headers,body:{query:workspaceQuery,variables:{id:foreignFixture.nativeScope}}});
            const admin=await call('/admin-panel',{native:true,method:'GET',headers});
            const noPeer=await call('/metadata',{native:true,headers:{Cookie:session.data.nativeCookie,Origin:manifest.origin},body:query});
            const wrong=await call('/metadata',{native:true,headers:{...headers,'x-ava-native-binding':crypto.randomUUID()},body:query});
            check(foreign.status===403&&admin.status===403&&noPeer.status===403&&wrong.status===403,'NATIVE_NEGATIVE_PROOF_FAILED');
            check(!foreignWorkspace.data?.data?.getPublicWorkspaceDataById && (foreignWorkspace.status===403 || foreignWorkspace.data?.errors?.length),'NATIVE_FOREIGN_WORKSPACE_DENIED_FAILED');
            return {...input,ownAccess:true,foreignAccessDenied:true,platformAdminDenied:true,sessionGuardVerified:true};
        }});
        const gateway={publicOrigin:manifest.origin,avaOrigin:'https://wh.meludtech.tech',
            brokerOrigin:'http://broker:3901',nativeOrigin:'http://native:3902',upstreamOrigin:'http://native:3000',
            adapterId:configured.id,deploymentId:manifest.deploymentId,businessId:1,module:'twenty',nativeScope:manifest.nativeScope};
        fs.writeFileSync(`${ROOT}/gateway.json`,JSON.stringify(gateway,null,2),{mode:0o600});
        fs.chownSync(`${ROOT}/gateway.json`,1000,1000);
        console.log(JSON.stringify({businessId:1,userId:user.id,adapterId:configured.id,nativeUserId:member.nativeUserId,
            nativeScope:manifest.nativeScope,proof:'native_http_verified',browser_verified:false,legacy_sync_endpoint_unchanged:true}));
    } finally {
        if(minted){const removed=await call('/v1/sessions/revoke',{body:{bindingId}});
            check(removed.status===200&&removed.data?.nativeSessionAbsent===true,'PROOF_SESSION_CLEANUP_FAILED');}
        DB.db.close();
    }
}
main().catch(error=>{console.error(/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'TWENTY_ENTRY_PROOF_FAILED');process.exitCode=1;});
