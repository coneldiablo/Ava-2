// Move only the existing business-1 binding to its verified native workspace URL.
// Run in whatsapp_crm. Never reconfigure credentials, mappings or sync mode.
const {createRequire}=require('node:module');
const assert=require('node:assert/strict');
const r=createRequire('/app/package.json');
const DB=r('./src/services/database.service');
const Store=r('./src/services/twenty/twenty-store.service');
const Service=r('./src/services/twenty/twenty.service');
const mode=process.argv[2];
if (!['--preview','--apply'].includes(mode)) throw new Error('Explicit mode required');
DB.db=new(r('better-sqlite3'))('/app/data/crm_v2.db');
const businessId=1;
const workspaceId='72600089-b4b4-4db3-a8b9-362f07033467';
const recordId='b0769054-5bf5-5a8b-bef8-d57319ce5183';
const oldUrl='https://crm.meludtech.tech';
const newUrl='https://ava-hotels.crm.meludtech.tech';
function record(value) {
    if (!value || typeof value!=='object') return null;
    return value.id ? value : Object.values(value).map(record).find(Boolean);
}
let stage='preflight';
(async()=>{
    const before=Store.getIntegration(businessId);
    assert.equal(before.workspaceId,workspaceId);
    assert([oldUrl,newUrl].includes(before.baseUrl));
    for (const baseUrl of [oldUrl,newUrl]) {
        stage='verify_same_workspace_record';
        const item=record(await Service._client({...before,baseUrl}).getRecord('tasks',recordId));
        assert.equal(item?.id,recordId);
        assert.equal(String(item.avaBusinessId),'1');
        assert.equal(item.status,'DONE');
    }
    stage='atomic_url_update';
    const changed=DB.db.transaction(()=>{
        const current=Store.getIntegration(businessId);
        for(const field of ['workspaceId','baseUrl','apiKeyEncrypted','mode','enabled']) {
            assert.equal(current[field],before[field]);
        }
        assert.equal(DB.get('SELECT isActive FROM instances WHERE id=?',[businessId]).isActive,1);
        if(mode==='--preview' || current.baseUrl===newUrl) return 0;
        return DB.run('UPDATE twenty_workspace_links SET baseUrl=?,updatedAt=CURRENT_TIMESTAMP WHERE businessId=?',
            [newUrl,businessId]).changes;
    }).immediate();
    console.log(JSON.stringify({success:true,mode,business_id:businessId,workspace_id:workspaceId,
        target_url:newUrl,verified_same_record:true,changed_rows:changed,credentials_and_mappings_preserved:true}));
})().catch(error=>{
    console.log(JSON.stringify({success:false,stage,error_code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'WORKSPACE_URL_CHECK_FAILED'}));
    process.exitCode=1;
}).finally(()=>DB.db.close());
