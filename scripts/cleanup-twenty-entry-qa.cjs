'use strict';
// Operator-only: retire exactly the acceptance account created for this entry.
process.env.AVA_PROCESS_ROLE='provisioning-worker';
const Database=require('/app/node_modules/better-sqlite3');
const Logger=require('/app/src/utils/logger');
for(const k of ['info','warn','error','debug','success'])Logger[k]=()=>{};
const DB=require('/app/src/services/database.service');
const Identity=require('/app/src/services/identity/identity-store');
const Access=require('/app/src/services/identity/module-access-store');
let stage='database';
(async()=>{
 // Cleanup must not run unrelated bootstrap/schema-sync migrations. Open the
 // already existing, explicitly mounted CRM database only.
 DB.db=new Database('/app/data/crm_v2.db',{fileMustExist:true});
 DB.db.pragma('foreign_keys = ON');
 stage='identity';
 const user=DB.get('SELECT * FROM ava_users WHERE id=?',['dc146361-6d3a-4523-b11b-3d9e2f5a56cc']);
 if(!user||user.id!=='dc146361-6d3a-4523-b11b-3d9e2f5a56cc'||!/^customer-diagnostic-[a-f0-9-]+@example\.invalid$/.test(user.email))throw Error('QA_IDENTITY_MISMATCH');
 stage='revoke';
 Identity.revokeUser({platformRole:'platform_admin',userId:'entry-acceptance-operator'},user.id);
 Access.collectRevocations();
 console.log(JSON.stringify({qaUserId:user.id,disabled:true,ownerUnchanged:true,nativeCleanupQueued:true}));
 DB.db.close();
})().catch(error=>{console.error(JSON.stringify({error:'ENTRY_QA_CLEANUP_FAILED',stage,
 code:/^(SQLITE_[A-Z_]+|E[A-Z]+)$/.test(error.code||'')?error.code:undefined}));process.exitCode=1});
