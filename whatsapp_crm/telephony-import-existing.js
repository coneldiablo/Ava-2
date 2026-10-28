'use strict';
// Local operator command; no HTTP session impersonation. A scoped runtime grant
// is mandatory and is rechecked by the worker. Never accepts or prints secrets.
require('dotenv').config();
async function main(args=process.argv.slice(2)) {
    if(args.length!==5 || args[4]!=='--confirm-unused') throw new Error('TELEPHONY_INPUT_INVALID');
    const [business,number,mode,key]=args,businessId=Number(business);
    if(!Number.isSafeInteger(businessId) || businessId<1) throw new Error('TELEPHONY_INPUT_INVALID');
    process.env.AVA_PROCESS_ROLE='provisioning-worker';
    const DB=require('./src/services/database.service');
    await DB.init();
    try {
        require('./src/services/identity/identity-store').ensureSchema();
        const Store=require('./src/services/telephony/store');
        const job=require('./src/services/telephony/existing').begin(businessId,{number,mode,confirmUnused:true},key,null,Date.now(),{operator:true});
        process.stdout.write(JSON.stringify({success:true,operation:Store.publicOperation(job)})+'\n');
    } finally {DB.db.close();}
}
if(require.main===module) main().catch(e=>{
    const code=/^(TELEPHONY_|BUSINESS_)[A-Z_]+$/.test(e.code || e.message || '')?(e.code || e.message):'TELEPHONY_IMPORT_FAILED';
    process.stderr.write(JSON.stringify({success:false,code})+'\n');process.exitCode=1;
});
module.exports={main};
