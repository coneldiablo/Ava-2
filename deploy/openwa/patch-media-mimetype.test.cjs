'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {patch}=require('./patch-media-mimetype.cjs');
const source=`class Message {
    async downloadMedia() {
        return window.manager({
                        type: msg.type,
                        signal: new AbortController().signal,
        });
    }
    async delete() { return 'unrelated'; }
}`;
test('passes the model MIME for both voice and image without disabling validation',async()=>{
 const result=patch(source);
 for(const [type,mimetype]of[['ptt','audio/ogg; codecs=opus'],['image','image/jpeg']]){
  let seen;const Message=vm.runInNewContext(result+'; Message',{msg:{type,mimetype},AbortController,
   window:{manager:value=>{seen=value;if(!value.mimetype)throw Error('InvalidMediaFileType');return{bytes:1};}}});
  assert.equal((await new Message().downloadMedia()).bytes,1);assert.equal(seen.mimetype,mimetype);assert.equal(seen.type,type);
  assert.equal(await new Message().delete(),'unrelated');
 }
});
test('refuses drift or a repeated patch',()=>{
 assert.throws(()=>patch('changed implementation'),/BASELINE_MISMATCH/);
 assert.throws(()=>patch(patch(source)),/BASELINE_MISMATCH/);
});
