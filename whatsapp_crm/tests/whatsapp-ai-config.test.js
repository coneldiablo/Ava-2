const {describe,it,assert,createTestDB}=require('./test-helper');
const AI=require('../src/services/ai.service');const config=require('../src/config');const DB=require('../src/services/database.service');
const path=require('path');const {spawnSync}=require('child_process');
function withKey(key,fn){const before=config.aiTunnel.apiKey;config.aiTunnel.apiKey=key;try{return fn();}finally{config.aiTunnel.apiKey=before;}}
describe('WhatsApp shared AITunnel credential inheritance',()=>{
    it('reproduces the live new-business missing credential error without a provider request',async()=>{
        createTestDB();const business=await DB.createInstance({name:'New owner fixture'});
        withKey('',()=>assert.throws(()=>AI._resolveProviderConfig(business),e=>e.code==='AI_PROVIDER_NOT_CONFIGURED'));
    });
    it('inherits the explicitly configured shared key for a new business and preserves an existing tenant override',()=>{
        withKey(' shared-fixture-key ',()=>{
            assert.strictEqual(AI._resolveProviderConfig({yandexGptKey:''}).apiKey,'shared-fixture-key');
            assert.strictEqual(AI._resolveProviderConfig({yandexGptKey:'tenant-fixture-key'}).apiKey,'tenant-fixture-key');
            assert.strictEqual(AI._resolveProviderConfig({yandexGptKey:'   '}).apiKey,'shared-fixture-key');
        });
    });
    it('never inherits another business credential when the approved shared key is absent',()=>{
        withKey('',()=>{
            assert.strictEqual(AI._resolveProviderConfig({yandexGptKey:'other-tenant-key'}).apiKey,'other-tenant-key');
            assert.throws(()=>AI._resolveProviderConfig({yandexGptKey:''}),e=>e.code==='AI_PROVIDER_NOT_CONFIGURED');
        });
    });
    it('uses canonical shared environment variables and ignores whitespace ahead of legacy aliases',()=>{
        const file=path.resolve(__dirname,'../src/config/index.js');
        for(const [env,expected] of [
            [{AITUNNEL_API_KEY:'canonical-fixture',AI_TUNNEL_API_KEY:'alias-fixture',YANDEX_GPT_API_KEY:'legacy-fixture'},'canonical-fixture'],
            [{AITUNNEL_API_KEY:' ',AI_TUNNEL_API_KEY:'alias-fixture',YANDEX_GPT_API_KEY:'legacy-fixture'},'alias-fixture'],
            [{AITUNNEL_API_KEY:' ',AI_TUNNEL_API_KEY:' ',YANDEX_GPT_API_KEY:'legacy-fixture'},'legacy-fixture']]){
            const result=spawnSync(process.execPath,['-e',`require('assert').strictEqual(require(${JSON.stringify(file)}).aiTunnel.apiKey,process.env.FIXTURE_EXPECTED)`],{env:{...process.env,...env,FIXTURE_EXPECTED:expected},encoding:'utf8'});
            assert.strictEqual(result.status,0,'environment inheritance fixture failed');
        }
    });
});
