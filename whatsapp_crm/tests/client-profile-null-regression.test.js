'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
describe('Client profile explicit NULL and omitted field compatibility',()=>{
    it('clears explicit nullable profile fields as SQL NULL while preserving omitted facts and JSON arrays',()=>{
        createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
        DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'guest','Guest'),(2,'guest','Foreign')");
        DB.upsertClientProfileSync(1,'guest',{needs:'Known request',budget:'Known budget',objections:'Known concern',timezone:'Europe/Moscow'});
        DB.upsertClientProfileSync(2,'guest',{needs:'Foreign request',budget:'Foreign budget'});
        const cleared=DB.upsertClientProfileSync(1,'guest',{needs:null,objections:null,timezone:null,interests:['suite']});
        assert.strictEqual(cleared.needs,null);assert.strictEqual(cleared.objections,null);assert.strictEqual(cleared.timezone,null);
        assert.strictEqual(cleared.budget,'Known budget');assert.deepStrictEqual(JSON.parse(cleared.interests),['suite']);
        assert.strictEqual(DB.get("SELECT needs IS NULL AS cleared FROM client_profiles WHERE instanceId=1 AND chatId='guest'").cleared,1);
        assert.strictEqual(DB.get("SELECT needs FROM client_profiles WHERE instanceId=2 AND chatId='guest'").needs,'Foreign request');
        assert.strictEqual(DB.upsertClientProfileSync(1,'guest',{}).budget,'Known budget');
    });
});
