'use strict';
// Real Express/SQLite fixture server, never App.start or a production DB.
// Reuse the frozen external-boundary fixture setup, adding only local audit RPC.
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net');
const repo=path.resolve(__dirname,'..');
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
    const first=Array.isArray(args[0])?args[0][0]:args[0];
    const options=first&&typeof first==='object'?first:{port:first,host:typeof args[1]==='string'?args[1]:'localhost'};
    if(options.path||typeof first==='string'&&!/^\d+$/.test(first)||!['127.0.0.1','localhost','::1','[::1]'].includes(options.host||options.hostname||'localhost'))
        throw Object.assign(new Error('External socket forbidden in product journeys fixture'),{code:'FIXTURE_NETWORK_BLOCKED'});
    return connect.apply(this,args);
};
let fixture;
const sourceFiles=[];
function visit(dir){for(const entry of fs.readdirSync(path.join(repo,dir),{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory())visit(file);else if(/\.(?:tsx?|js|cjs)$/.test(entry.name))sourceFiles.push(file);}}
for(const dir of ['whatsapp_crm/frontend/src','whatsapp_crm/src'])visit(dir);
const sourceHashes=Object.fromEntries(sourceFiles.sort().map(file=>[file,hash(fs.readFileSync(path.join(repo,file)))]));
function apiIndex(app){const routes=[];function walk(stack,prefix=''){for(const layer of stack||[]){if(layer.route){for(const route of [].concat(layer.route.path))routes.push({path:prefix+route,methods:Object.keys(layer.route.methods).filter(method=>layer.route.methods[method]).sort()});}else if(layer.handle?.stack){const literal=layer.regexp?.source.match(/^\^((?:\\\/[a-zA-Z0-9_-]+)+)/)?.[1]?.replace(/\\/g,'');walk(layer.handle.stack,prefix+(literal||''));}}}walk(app._router?.stack);return routes;}
const originalSend=process.send.bind(process);
process.send=function(message,...args){
    if(message?.ready){
        const DB=require(path.join(repo,'whatsapp_crm/src/services/database.service'));
        const template=DB.run('INSERT INTO templates(instanceId,label,text) VALUES(?,?,?)',[1,'Приветствие проверки','Здравствуйте! Подготовим предложение по вашему звонку.']);
        fixture={DB,chatId:message.chatId,templateId:Number(template.lastInsertRowid)};
        const app=require(path.join(repo,'whatsapp_crm/src/app')).app;
        process.env.WHATSAPP_CRM_PUBLIC_URL='https://127.0.0.1:5317';
        message={...message,templateId:fixture.templateId,sourceHashes,apiRoutes:apiIndex(app)};
    }
    return originalSend(message,...args);
};
process.on('message',message=>{
    if(!fixture)return;
    const {DB}=fixture;
    try{
        let result;
        if(message.op==='journey-snapshot')result={profiles:DB.all('SELECT id,hotelTone,systemPrompt,hotelTimezone FROM instances'),overviews:DB.get("SELECT 1 FROM sqlite_master WHERE name='dashboard_period_overviews'")?DB.all('SELECT businessId,kind,start,endExclusive,version,content FROM dashboard_period_overviews'):[],templates:DB.all('SELECT id,instanceId,label,text FROM templates'),members:DB.all('SELECT userId,businessId,role FROM ava_business_memberships ORDER BY businessId,userId'),
            dealRows:DB.all('SELECT id,instanceId,title,stage,amountMinor FROM customer_deals'),knowledgeRows:DB.all('SELECT id,instanceId,originalName FROM knowledge_base'),taskRows:DB.all('SELECT taskId,instanceId,chatId,summary,status,assigneeUserId FROM manager_tasks'),
            messageCounts:DB.all('SELECT instanceId,COUNT(*) count FROM messages GROUP BY instanceId'),
            invitations:DB.all('SELECT i.id,i.businessId,u.email,i.role,i.state FROM ava_invitations i JOIN ava_users u ON u.id=i.userId')};
        else if(message.op==='workspace-fallback'){
            require(path.join(repo,'whatsapp_crm/src/services/ava-release-flags.service')).ensureSchema();
            DB.run('INSERT OR REPLACE INTO ava_release_flags(businessId,revision,flagsJson,updatedBy,updatedAt) VALUES(1,1,?,?,?)',[JSON.stringify({workspace:message.enabled!==true,analytics:true,autopilot:true}),'owner',new Date().toISOString()]);result={success:true};
        }else return;
        originalSend({id:message.id,result});
    }catch(error){originalSend({id:message.id,error:error.code||error.message});}
});
require('./customer-path-20261017-integrated-browser.server.cjs');
