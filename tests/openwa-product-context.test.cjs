'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const {transform} = require('../scripts/openwa-product-context/patch.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/openwa-0.23.4', name), 'utf8');
function load(name, dependencies = {}) {
    const exports = {};
    vm.runInNewContext(transform(name, fixture(name)), {
        exports, process, Buffer, URL,
        require: id => id in dependencies ? dependencies[id] : {},
    }, {filename:name});
    return exports;
}
const plain = value => value === undefined ? value : JSON.parse(JSON.stringify(value));
const product = {productId:'sku-7',title:'Fence kit',description:'For 7 hectares',businessOwnerJid:'merchant@c.us'};
function message(extra = {}) {
    return {id:{_serialized:'message-1'}, from:'customer@c.us',to:'merchant@c.us',body:'',type:'product',
        timestamp:100,fromMe:false,...product,...extra};
}
function modules() {
    const waId = {chatKind:id => id.endsWith('@g.us') ? 'group' : 'direct'};
    const mapper=load('message-mapper.js',{'../identity/wa-id':waId});
    const dependencies = {'./message-mapper':mapper,'../identity/wa-id':waId,
        'whatsapp-web.js':{MessageTypes:{LOCATION:'location'}},
        './wwebjs-host':{withPage:(_host,_context,op)=>op()}};
    const messaging=load('wwebjs-messaging.js',dependencies);
    const events=load('wwebjs-message-events.js',{...dependencies,'./wwebjs-messaging':messaging});
    return {mapper,messaging,events};
}
test('product metadata survives mapping without changing existing type, status or direction semantics', () => {
    const {mapper}=modules();
    const mapped=mapper.buildIncomingMessageBase(message());
    assert.deepEqual(plain(mapped.product),product);
    assert.equal(mapped.type,'unknown');
    assert.equal(mapped.chatId,'customer@c.us');
    assert.equal(mapped.isStatusBroadcast,false);
    assert.equal(mapper.mapWwebjsMessageType('order'),'unknown');
    assert.equal(mapper.mapWwebjsMessageType('chat'),'text');
    assert.equal(mapper.mapWwebjsMessageType('ptt'),'voice');
    const own=mapper.buildIncomingMessageBase(message({fromMe:true,from:'merchant@c.us',to:'group@g.us'}));
    assert.equal(own.chatId,'group@g.us');
    assert.equal(own.isGroup,true);
});
test('bodyless product requires a product id and never promotes unrelated raw payload', () => {
    const {mapper}=modules();
    for (const candidate of [message({type:'chat'}),message({productId:''}),message({productId:undefined})]) {
        assert.equal(mapper.buildIncomingMessageBase(candidate).product,undefined);
    }
    const mapped=mapper.buildIncomingMessageBase(message({title:undefined,description:undefined,businessOwnerJid:undefined}));
    assert.deepEqual(plain(mapped.product),{productId:'sku-7'});
});
test('live inbound quoted product reaches the registered callback', async () => {
    const {events}=modules(),handlers={},received=[];
    const errors=[];
    events.registerWwebjsMessageEvents({on:(name,handler)=>{handlers[name]=handler;}},{
        logger:{error:(...args)=>errors.push(args),warn:()=>{}},getCallbacks:()=>({onMessage:m=>received.push(m)}),
    });
    await handlers.message(message({type:'chat',body:'Is this available?',hasQuotedMsg:true,
        getContact:async()=>null,getQuotedMessage:async()=>message({id:{$1:'quoted-7'}})}));
    assert.equal(errors.length,0);
    assert.deepEqual(plain(received[0].quotedMessage),{id:'quoted-7',body:'',product});
    assert.equal(received[0].product,undefined);
});
test('history retains direct and quoted products and still synthesizes media by existing rules', async () => {
    const {messaging}=modules();
    const history=[message(),message({type:'chat',body:'Price?',hasQuotedMsg:true,
        getQuotedMessage:async()=>message({id:{_serialized:'quoted-7'}})})];
    const host={ensureReady:()=>{},getClient:()=>({getChatById:async()=>({fetchMessages:async()=>history})}),logger:{warn:()=>{}}};
    const result=await new messaging.WwebjsMessaging(host).getChatHistory('customer@c.us',50,false);
    assert.deepEqual(plain(result[0].product),product);
    assert.deepEqual(plain(result[1].quotedMessage),{id:'quoted-7',body:'',product});
    const rows=load('message-row.mapper.js');
    assert.deepEqual(plain(rows.buildMessageMetadata(result[0])),{product});
    assert.deepEqual(plain(rows.buildMessageMetadata(result[1])),{quotedMessage:{id:'quoted-7',body:'',product}});
    assert.equal(rows.buildMessageMetadata({type:'text'}),undefined);
    assert.deepEqual(plain(rows.buildMessageMetadata({type:'image'},true)),{media:{mimetype:'',omitted:true}});
    assert.equal(rows.storableWaMessageId(''),undefined);
});
test('a changed preimage fails closed before any file is written', () => {
    const {apply}=require('../scripts/openwa-product-context/patch.cjs');
    const manifest=require('../scripts/openwa-product-context/manifest.json');
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ava-openwa-test-'));
    try {
        const originals=[];
        for(const entry of manifest.files) {
            const target=path.join(root,entry.target.replace(/^\/app\//,''));
            fs.mkdirSync(path.dirname(target),{recursive:true});
            const source=fixture(path.basename(target));
            fs.writeFileSync(target,source);
            originals.push({target,source});
        }
        fs.appendFileSync(originals.at(-1).target,'\n// drift\n');
        assert.throws(()=>apply(root),/EXACT_PREIMAGE_DRIFT/);
        for(const {target,source} of originals.slice(0,-1)) assert.equal(fs.readFileSync(target,'utf8'),source);
        assert.throws(()=>transform('message-mapper.js',fixture('message-mapper.js')+'\n'),/EXACT_PREIMAGE_DRIFT/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});
