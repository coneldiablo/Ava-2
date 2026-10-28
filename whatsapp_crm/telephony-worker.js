'use strict';
require('dotenv').config();
// This entrypoint never loads the provisioning, identity mail/recovery, channel
// consumers or outbound campaign queues. DB/init is migration-only in worker role.
async function startRuntime({db=require('./src/services/database.service'),
    identity=require('./src/services/identity/identity-store'),
    worker=require('./src/services/telephony/worker'),schedule=setInterval,cancel=clearInterval}={}) {
    await db.init();identity.ensureSchema();
    require('./src/services/telephony/store').ensureSchema();
    let stopping=false,busy=false;
    const tick=async()=>{
        if(stopping || busy) return;
        busy=true;try {await worker.processOne();} catch(_) {process.stderr.write('TELEPHONY_WORKER_FAILED\n');}
        finally {busy=false;}
    };
    const timer=schedule(tick,3000);
    const shutdown=async()=>{
        if(stopping) return;stopping=true;cancel(timer);
        const until=Date.now()+25000;
        while(busy && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,100));
        if(!busy && db.db?.open) db.db.close();
    };
    return {tick,shutdown};
}
if(require.main===module) {
    process.env.AVA_PROCESS_ROLE='provisioning-worker';
    startRuntime().then(runtime=>{
        process.once('SIGTERM',()=>runtime.shutdown());process.once('SIGINT',()=>runtime.shutdown());
        process.stdout.write('TELEPHONY_WORKER_READY\n');
    }).catch(()=>{process.stderr.write('TELEPHONY_WORKER_START_FAILED\n');process.exitCode=1;});
}
module.exports={startRuntime};
