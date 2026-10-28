'use strict';
const net=require('net');
const DB=require('../database.service');
const Identity=require('../identity/identity-store');
const Store=require('./store');
const Vault=require('./credentials');
const Existing=require('./existing');
const {ExolveClient}=require('./exolve-client');
const {HostClient}=require('./host-client');
const {LIMITS,kopecks,did,fail,assertPilot}=require('./policy');
const terminal=['done','failed','manual','canceled'];
function prices(number,sip) {
    if(number.number_options?.incoming_calls!==true || number.number_options?.outgoing_calls!==true)
        fail('TELEPHONY_DIRECTIONS_UNAVAILABLE',409);
    const p={numberInstall:kopecks(number.install_fee),numberMonthly:kopecks(number.subscription_fee),
        sipInstall:kopecks(sip.install_fee),sipMonthly:kopecks(sip.subscription_fee)};
    return {...p,installKopecks:p.numberInstall+p.sipInstall,monthlyKopecks:p.numberMonthly+p.sipMonthly};
}
function staticTarget() {
    const ip=process.env.EXOLVE_STATIC_IP,port=Number(process.env.EXOLVE_STATIC_PORT || 5060);
    if(net.isIP(ip)!==4 || !Number.isInteger(port) || port<1 || port>65535) fail('TELEPHONY_STATIC_NOT_CONFIGURED',503);
    return {ip,port};
}
function forwardingMatches(row,phone,target) {
    const values=Array.isArray(row?.call_forwarding_ip_static)?row.call_forwarding_ip_static:[row?.call_forwarding_ip_static];
    return row?.call_forwarding_flag===true && values.some(v=>v && String(v.did_name)===phone.number && v.ip===target.ip && Number(v.port)===target.port);
}
class PhoneWorker {
    constructor({provider=new ExolveClient(),host=new HostClient(),now=()=>Date.now()}={}) {
        this.provider=provider;this.host=host;this.now=now;this.busy=false;this.lastMaintenance=0;
    }
    async processOne() {
        if(this.busy) return false;
        this.busy=true;
        let job,heartbeat;
        try {
            Store.ensureSchema();
            job=Store.lease(this.now(),['external_apply','external_check','external_remove']);
            if(!job&&this.now()-this.lastMaintenance>=60000) {
                this.lastMaintenance=this.now();
                try {await this.maintenance();}
                catch(_) {Store.alert('TELEPHONY_MAINTENANCE_FAILED',null,this.now());}
            }
            if(!job)job=Store.lease(this.now(),process.env.AVA_TELEPHONY_PURCHASE_ENABLED==='true'?null:['catalog','inventory','import','release']);
            if(!job) return false;
            heartbeat=setInterval(()=>{
                try { DB.run('UPDATE ava_phone_operations SET leaseUntil=? WHERE id=? AND leaseToken=? AND leaseUntil>?',
                    [this.now()+60000,job.id,job.leaseToken,this.now()]); } catch (_) {}
            },15000); heartbeat.unref?.();
            if(job.kind.startsWith('external_')) await require('./external-sip').run(this,job);
            else if(job.kind==='import') await Existing.run(this,job,{staticTarget,forwardingMatches});
            else if(job.kind==='inventory') {
                Identity.authorizeCapability({userId:job.actorUserId},job.businessId,'business.manage');
                await Existing.inventory(this,job);
                Identity.authorizeCapability({userId:job.actorUserId},job.businessId,'business.manage');
                this.advance(job,'done',{state:'done',resultJson:JSON.stringify({candidates:Existing.candidates(job.businessId)})});
            }
            else if(job.kind==='catalog' || job.kind==='quotes') await this.readRequest(job);
            else if(job.kind==='purchase') await this.purchase(job);
            else if(job.kind==='release') await this.release(job);
            return true;
        } catch(error) {
            if(job) {
                // A failed transaction may have rolled back stage changes in the in-memory job.
                const actual=Store.operation(job.id);
                const code=/^(TELEPHONY_|BUSINESS_|CAPABILITY_|ACCOUNT_)/.test(error.code || '')?error.code:'TELEPHONY_OPERATION_FAILED';
                if(actual?.leaseToken===job.leaseToken && !terminal.includes(actual.state)) {
                    const p=job.phoneId?Store.phone(job.phoneId):null;
                    const paid=actual.kind==='purchase' && !['validate','locking','locked'].includes(actual.stage);
                    if(error.code==='TELEPHONY_LEASE_LOST') return false;
                    if(actual.kind.startsWith('external_')) {
                        if(['TELEPHONY_SIP_REVISION_CHANGED','TELEPHONY_RELEASE_CHANGED'].includes(code)) this.advance(actual,'canceled',{state:'canceled',errorCode:code});
                        else if(/^(BUSINESS_|CAPABILITY_|ACCOUNT_)/.test(code)||['TELEPHONY_SIP_HOST_PRIVATE','TELEPHONY_SIP_TRANSPORT_UNAVAILABLE','TELEPHONY_NUMBER_ALREADY_BOUND','TELEPHONY_VAULT_READ_FAILED'].includes(code)) this.manual(actual,code,p);
                        else this.defer(actual,code,30000);
                    }
                    else if(actual.kind==='import' && actual.stage!=='import_validate') {this.manual(actual,code,p);}
                    else if(paid || actual.kind==='release' || error.uncertain) {
                        if(actual.attempts>=20) this.manual(actual,code,p);
                        else Store.defer(actual,code,this.now(),Math.min(300000,10000*Math.max(1,actual.attempts)));
                    } else {
                        this.failUnpaid(actual,p,code);
                    }
                }
            } else { Store.alert('TELEPHONY_MAINTENANCE_FAILED',null,this.now()); }
            return false;
        } finally { if(heartbeat) clearInterval(heartbeat);this.busy=false; }
    }
    failUnpaid(job,p,code=null) {
        Store.transaction(()=>{
            this.advance(job,'failed',{state:'failed',errorCode:code,spendReserved:0});
            if(p) {
                DB.run("UPDATE ava_phone_numbers SET state='released',updatedAt=? WHERE id=? AND state='provisioning'",[this.now(),p.id]);
                Store.syncProjection(p.businessId);
                if(!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[p.businessId]))
                    DB.run('DELETE FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);
            }
        });
    }
    manual(job,code,p=Store.phone(job.phoneId)) {
        Store.transaction(()=>{
            const changed=DB.run("UPDATE ava_phone_operations SET state='manual',errorCode=?,leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=? AND leaseToken=? AND leaseUntil>?",
                [code,this.now(),job.id,job.leaseToken,this.now()]);
            if(!changed.changes) return;
            if(p) DB.run("UPDATE ava_phone_numbers SET state='manual',inboundReady=0,outboundReady=0 WHERE id=? AND state<>'released'",[p.id]);
            Store.alert(code,p,this.now());
            if(p) Store.syncProjection(p.businessId);
        });
    }
    advance(job,stage,values={}) { Store.advance(job,stage,values,this.now()); }
    defer(job,code=null,delay=10000) {
        if(job.attempts>=20 && code!=='TELEPHONY_CALLS_DRAINING') this.manual(job,code || 'TELEPHONY_RECONCILIATION_REQUIRED');
        else Store.defer(job,code,this.now(),delay);
    }
    async fenced(job, action) {
        Store.assertLease(job,this.now());
        const result=await action();
        Store.assertLease(job,this.now());
        return result;
    }
    async balance(job=null) {
        const started=this.now();
        const result=job?await this.fenced(job,()=>this.provider.balance()):await this.provider.balance();
        Store.recordBalance(kopecks(result.balance),started,this.now());
        return result;
    }
    async readRequest(job) {
        if(job.kind!=='catalog') assertPilot(job.businessId);
        Identity.authorizeCapability({userId:job.actorUserId},job.businessId,'business.read');
        let result;
        if(job.kind==='catalog') {
            const raw=await this.fenced(job,()=>this.provider.catalog());
            if(!Array.isArray(raw.types) || !Array.isArray(raw.regions)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
            result={types:raw.types.filter(x=>x && [1104,1105].includes(Number(x.type_id)))
                .map(x=>({type_id:Number(x.type_id),type_name:typeof x.type_name==='string'?x.type_name.slice(0,100):String(x.type_id)})),
                regions:raw.regions.filter(x=>x && Number.isSafeInteger(Number(x.region_id)) && Number(x.region_id)>0)
                    .map(x=>({id:Number(x.region_id),name:String(x.description || x.region_name || x.region_id).slice(0,200)}))};
            Store.setMeta('catalog',result,this.now());
        } else {
            const input=JSON.parse(job.inputJson);
            const catalog=Store.meta('catalog');
            if(!catalog || !JSON.parse(catalog.value).types.some(x=>x.type_id===input.typeId)
                || !JSON.parse(catalog.value).regions.some(x=>x.id===input.regionId)) fail('TELEPHONY_REGION_INVALID');
            const categoryId=input.typeId===1104?10000:10001;
            const [numbers,sip]=await this.fenced(job,()=>Promise.all([this.provider.free({type_id:input.typeId,region_id:input.regionId,category_id:categoryId,random:true,limit:20}),
                this.provider.fees(),this.balance(job)]));
            if(!Array.isArray(numbers)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
            const quotes=[];
            Store.transaction(()=>{
                Store.assertLease(job,this.now());
                for(const row of numbers) {
                    let p,number;
                    try {p=prices(row,sip);number=did(row.number_code);} catch(_){continue;}
                    if(quotes.some(q=>q.number===number) || p.installKopecks>LIMITS.install || p.monthlyKopecks>LIMITS.monthly
                        || DB.get("SELECT id FROM ava_phone_numbers WHERE number=? AND state<>'released'",[number])
                        || DB.get('SELECT alias FROM business_sip_aliases WHERE alias=?',[number])) continue;
                    const quote={id:Store.uuid(),businessId:job.businessId,number,typeId:input.typeId,regionId:input.regionId,categoryId,...p,
                        expiresAt:this.now()+LIMITS.quoteMs,createdAt:this.now()};
                    DB.run(`INSERT INTO ava_phone_quotes(id,businessId,number,typeId,regionId,categoryId,installKopecks,monthlyKopecks,
                        numberInstall,numberMonthly,sipInstall,sipMonthly,expiresAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [quote.id,quote.businessId,quote.number,quote.typeId,quote.regionId,quote.categoryId,quote.installKopecks,
                        quote.monthlyKopecks,quote.numberInstall,quote.numberMonthly,quote.sipInstall,quote.sipMonthly,quote.expiresAt,quote.createdAt]);
                    quotes.push({id:quote.id,number,installKopecks:p.installKopecks,monthlyKopecks:p.monthlyKopecks,expiresAt:quote.expiresAt});
                    if(quotes.length>=5) break;
                }
            });
            result={quotes};
        }
        // Re-check ownership after external reads, before exposing their result.
        Identity.authorizeCapability({userId:job.actorUserId},job.businessId,'business.read');
        this.advance(job,'done',{state:'done',errorCode:null,resultJson:JSON.stringify(result)});
    }
    grant(job) {
        Store.assertLease(job,this.now());
        assertPilot(job.businessId);
        Identity.authorizeCapability({userId:job.actorUserId},job.businessId,'business.manage');
        if(!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[job.businessId])) fail('BUSINESS_NOT_FOUND',404);
    }
    async purchased(phone,job=null) {
        const inventory=job?await this.fenced(job,()=>this.provider.inventory()):await this.provider.inventory();
        if(!Array.isArray(inventory) || inventory.some(r=>!r || !/^7\d{10}$/.test(String(r.number_name)) || typeof r.application_uuid!=='string'))
            fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
        return inventory.find(r=>String(r.number_name)===phone.number && r.application_uuid===phone.applicationId);
    }
    async purchase(job) {
        let p=Store.phone(job.phoneId);
        if(!p || p.applicationId!==this.provider.applicationId) fail('TELEPHONY_PROVIDER_SCOPE_MISMATCH',409);
        const input=JSON.parse(job.inputJson);
        const target=staticTarget();
        if(job.stage==='validate') {
            this.grant(job); Vault.key();
            const health=await this.fenced(job,()=>this.host.health());
            if(health.ingressReady!==true) fail('TELEPHONY_INGRESS_NOT_READY',409);
            if(await this.purchased(p,job)) fail('TELEPHONY_PROVIDER_NUMBER_EXISTS',409);
            const [rows,sip,balance]=await this.fenced(job,()=>Promise.all([this.provider.free({type_id:input.typeId,region_id:input.regionId,
                category_id:input.categoryId,mask:p.number,limit:1}),this.provider.fees(),this.balance(job)]));
            if(!Array.isArray(rows)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
            const row=rows.find(r=>String(r.number_code)===p.number);
            if(!row) fail('TELEPHONY_NUMBER_NO_LONGER_FREE',409);
            const current=prices(row,sip);
            if(['numberInstall','numberMonthly','sipInstall','sipMonthly'].some(k=>current[k]!==input[k])) fail('TELEPHONY_PRICE_CHANGED',409);
            const held=Store.reservedSpend();
            if(kopecks(balance.balance)<held) fail('TELEPHONY_BALANCE_LOW',409);
            this.grant(job);
            this.advance(job,'locking',{lockAt:this.now()});
            const locked=await this.fenced(job,()=>this.provider.lock(p.number));
            const uid=String(locked.Id || locked.id || '');
            if(!/^\d+$/.test(uid)) fail('TELEPHONY_LOCK_RESPONSE_UNKNOWN',503);
            this.advance(job,'locked',{lockId:uid});
        } else if(job.stage==='locking') {
            // Lock has no lookup. No purchase was dispatched; wait for its maximum TTL.
            if(this.now()<(job.lockAt || job.updatedAt)+310000) {this.defer(job,'TELEPHONY_LOCK_RECONCILING',30000);return;}
            this.advance(job,'validate');this.defer(job,null,1000);return;
        }
        if(job.stage==='locked') {
            try {this.grant(job);} catch(error) {
                await this.fenced(job,()=>this.provider.unlock(p.number,job.lockId));throw error;
            }
            if(this.now()-job.lockAt>280000) {
                await this.fenced(job,()=>this.provider.unlock(p.number,job.lockId));this.advance(job,'validate');this.defer(job,null,1000);return;
            }
            const health=await this.fenced(job,()=>this.host.health());
            if(health.ingressReady!==true) fail('TELEPHONY_INGRESS_NOT_READY',409);
            this.grant(job);
            this.advance(job,'buy_dispatching');
            try {await this.fenced(job,()=>this.provider.buy(p.number,job.lockId));this.advance(job,'buy_confirm');}
            catch(error) {
                if(error.uncertain) {this.defer(job,error.code);return;}
                this.advance(job,'buy_rejected');
                await this.fenced(job,()=>this.provider.unlock(p.number,job.lockId));
                this.failUnpaid(job,p,error.code);return;
            }
        }
        if(job.stage==='buy_rejected') {
            // Definitive rejection: release the lock only, never delete a number.
            await this.fenced(job,()=>this.provider.unlock(p.number,job.lockId));
            this.failUnpaid(job,p,job.errorCode);return;
        }
        if(['buy_dispatching','buy_confirm'].includes(job.stage)) {
            const bought=await this.purchased(p,job);
            if(!bought) {this.defer(job,'TELEPHONY_PURCHASE_RECONCILING',30000);return;}
            let matched=false;
            try {matched=kopecks(bought.install_fee)===input.numberInstall && kopecks(bought.subscription_fee)===input.numberMonthly;} catch(_) {}
            if(!matched) {this.advance(job,'compensate',{errorCode:'TELEPHONY_PRICE_CHANGED'});return this.compensate(job,p);}
            this.advance(job,'sip_pending');
        }
        if(job.stage==='sip_pending') {
            try {this.grant(job);} catch(_) {this.advance(job,'compensate');return this.compensate(job,p);}
            const fees=await this.fenced(job,()=>this.provider.fees());
            let matched=false;
            try {matched=kopecks(fees.install_fee)===input.sipInstall && kopecks(fees.subscription_fee)===input.sipMonthly;} catch(_) {}
            if(!matched) {this.advance(job,'compensate',{errorCode:'TELEPHONY_PRICE_CHANGED'});return this.compensate(job,p);}
            const found=(await this.fenced(job,()=>this.provider.sips())).filter(r=>r.sip_name===p.sipName);
            if(found.length) {this.manual(job,'TELEPHONY_SIP_NAME_COLLISION',p);return;}
            this.advance(job,'sip_dispatching');
            try {
                const created=await this.fenced(job,()=>this.provider.createSip(p.sipName,p.number));
                if(!/^\d+$/.test(String(created.sip_resource_id || ''))) fail('TELEPHONY_SIP_RESPONSE_UNKNOWN',503);
                Store.transaction(()=>{this.advance(job,'sip_confirm');DB.run('UPDATE ava_phone_numbers SET sipResourceId=? WHERE id=?',[String(created.sip_resource_id),p.id]);});
            } catch(error) {
                if(error.uncertain || error.code==='TELEPHONY_SIP_RESPONSE_UNKNOWN') {this.defer(job,error.code);return;}
                this.advance(job,'compensate');return this.compensate(job,p);
            }
        }
        if(job.stage==='sip_dispatching') {
            const found=(await this.fenced(job,()=>this.provider.sips())).filter(r=>r.sip_name===p.sipName && String(r.cli)===p.number && r.application_uuid===p.applicationId);
            if(found.length!==1) {this.defer(job,'TELEPHONY_SIP_RECONCILING',30000);return;}
            Store.transaction(()=>{this.advance(job,'sip_confirm');DB.run('UPDATE ava_phone_numbers SET sipResourceId=? WHERE id=?',[String(found[0].sip_resource_id),p.id]);});
        }
        p=Store.phone(p.id);
        if(job.stage==='sip_confirm') {
            const attributes=await this.fenced(job,()=>this.provider.sip(p.sipResourceId)),c=attributes.attributes;
            if(attributes.application_uuid!==p.applicationId || !c || String(c.cli)!==p.number || attributes.sip_name!==p.sipName)
                fail('TELEPHONY_SIP_SCOPE_MISMATCH',409);
            if(kopecks(c.install_fee)!==input.sipInstall || kopecks(c.subscription_fee)!==input.sipMonthly)
                {this.advance(job,'compensate',{errorCode:'TELEPHONY_PRICE_CHANGED'});return this.compensate(job,p);}
            const encrypted=Vault.encrypt({login:c.login,password:c.password,domain:c.domain},p);
            Store.transaction(()=>{this.advance(job,'host_apply');DB.run('UPDATE ava_phone_numbers SET encryptedCredentials=? WHERE id=?',[encrypted,p.id]);});
        }
        if(job.stage==='host_apply') {
            p=Store.phone(p.id);await this.fenced(job,()=>this.host.apply(p,Vault.decrypt(p.encryptedCredentials,p)));
            this.advance(job,'host_verify');
        }
        if(job.stage==='host_verify') {
            if((await this.fenced(job,()=>this.host.status(p))).registered!==true) {this.defer(job,'TELEPHONY_SIP_REGISTERING');return;}
            this.advance(job,'forwarding');
        }
        if(job.stage==='forwarding') {
            // Same target is safe to replay, but read back first after a lost response.
            const row=await this.purchased(p,job);
            if(!forwardingMatches(row,p,target)) {
                try { await this.fenced(job,()=>this.provider.forwarding(p.number,target.ip,target.port)); }
                catch(error) {
                    if(error.uncertain) throw error;
                    this.advance(job,'compensate');return this.compensate(job,p);
                }
            }
            this.advance(job,'forwarding_verify');
        }
        if(job.stage==='forwarding_verify') {
            if(!forwardingMatches(await this.purchased(p,job),p,target)) {this.defer(job,'TELEPHONY_FORWARDING_RECONCILING');return;}
            try {this.grant(job);} catch(_) {this.advance(job,'compensate');return this.compensate(job,p);}
            Store.activate(job,this.now());
        }
        if(job.stage==='compensate' || job.stage.startsWith('delete_')) await this.compensate(job,p);
    }
    async compensate(job,p) {
        if(p.activatedAt || p.origin!=='managed') {this.manual(job,'TELEPHONY_COMPENSATION_FORBIDDEN',p);return;}
        return this.deleteResources(job,Store.phone(p.id),true);
    }
    cancelRestoredRelease(job,p) {
        if(p.releaseReason!=='business_inactive' || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[p.businessId])) return false;
        Store.transaction(()=>{
            this.advance(job,'canceled',{state:'canceled'});
            DB.run("UPDATE ava_phone_numbers SET state='active',releaseAt=NULL,releaseReason=NULL,warningAt=NULL,inboundReady=1,outboundReady=CASE WHEN id IN (SELECT phoneId FROM ava_phone_existing_profiles WHERE mode='inbound_only') THEN 0 ELSE 1 END,generation=generation+1 WHERE id=?",[p.id]);
            DB.run("UPDATE ava_phone_alerts SET resolvedAt=? WHERE phoneId=? AND code='TELEPHONY_RELEASE_WARNING'",[this.now(),p.id]);
            Store.syncProjection(p.businessId);
        });return true;
    }
    async release(job) {
        const p=Store.phone(job.phoneId);
        if(p?.origin==='external')return require('./external-sip').run(this,job);
        if(!p || !['managed','existing'].includes(p.origin)) fail('TELEPHONY_RELEASE_SCOPE_INVALID',409);
        if(p.origin==='existing') return this.detachExisting(job,p);
        if(process.env.AVA_TELEPHONY_PURCHASE_ENABLED!=='true') {this.defer(job,'TELEPHONY_PROVIDER_DELETION_DISABLED',60000);return;}
        if(job.stage==='release_check') {
            if(this.cancelRestoredRelease(job,p)) return;
            if(p.state!=='releasing') fail('TELEPHONY_RELEASE_CHANGED',409);
            if(p.releaseAt>this.now()) {this.defer(job,null,60000);return;}
            if((await this.fenced(job,()=>this.host.calls())).active!==0 || DB.get("SELECT id FROM ava_phone_calls WHERE phoneId=? AND state='reserved'",[p.id]))
                {this.defer(job,'TELEPHONY_CALLS_DRAINING',30000);return;}
            if(this.cancelRestoredRelease(job,p)) return;
            this.advance(job,'compensate');
        }
        await this.deleteResources(job,p,false);
    }
    async detachExisting(job,p) {
        if(!['release_check','detach_host'].includes(job.stage)) fail('TELEPHONY_RELEASE_SCOPE_INVALID',409);
        if(job.stage==='release_check' && this.cancelRestoredRelease(job,p)) return;
        if(p.state!=='releasing' || p.releaseAt>this.now()) {this.defer(job,'TELEPHONY_RELEASE_CHANGED',60000);return;}
        if((await this.fenced(job,()=>this.host.calls())).active!==0
            || DB.get("SELECT id FROM ava_phone_calls WHERE phoneId=? AND state='reserved'",[p.id])) {
            this.defer(job,'TELEPHONY_CALLS_DRAINING',30000);return;
        }
        const profile=DB.get('SELECT * FROM ava_phone_existing_profiles WHERE phoneId=?',[p.id]);
        if(!profile) fail('TELEPHONY_RELEASE_SCOPE_INVALID',409);
        this.advance(job,'detach_host');
        if(profile.mode==='sip') await this.fenced(job,()=>this.host.remove(p));
        // Reactivation during host removal must restore and verify before cancel.
        if(p.releaseReason==='business_inactive' && DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[p.businessId])) {
            if(profile.mode==='sip') {
                await this.fenced(job,()=>this.host.apply(p,Vault.decrypt(p.encryptedCredentials,p)));
                if((await this.fenced(job,()=>this.host.status(p))).registered!==true) {this.defer(job,'TELEPHONY_SIP_REGISTERING');return;}
            }
            if(this.cancelRestoredRelease(job,p)) return;
        }
        Store.transaction(()=>{
            this.advance(job,'detached',{state:'done',errorCode:null});
            DB.run("UPDATE ava_phone_numbers SET state='released',isPrimary=0,inboundReady=0,outboundReady=0,encryptedCredentials=NULL,updatedAt=? WHERE id=?",[this.now(),p.id]);
            if(!profile.aliasExisted) {
                DB.run('DELETE FROM business_sip_aliases WHERE alias=? AND businessId=?',[p.number,p.businessId]);
                const i=DB.get('SELECT sipAliases FROM instances WHERE id=?',[p.businessId]);
                DB.run('UPDATE instances SET sipAliases=? WHERE id=?',[JSON.stringify(JSON.parse(i.sipAliases || '[]').filter(n=>n!==p.number)),p.businessId]);
            }
            const replacement=DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state='active' ORDER BY createdAt LIMIT 1",[p.businessId]);
            if(p.isPrimary && replacement) Store.primary(p.businessId,replacement.id);
            else if(p.isPrimary) DB.run('UPDATE instances SET sipCallerId=NULL,sipTrunkNumber=NULL WHERE id=?',[p.businessId]);
            if(!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[p.businessId])) {
                const manual=DB.get('SELECT * FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);
                if(manual) DB.run('UPDATE instances SET sipCallerId=?,sipTrunkNumber=? WHERE id=?',[manual.sipCallerId,manual.sipTrunkNumber,p.businessId]);
                DB.run('DELETE FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);
            }
            Store.syncProjection(p.businessId);
            DB.run('UPDATE ava_phone_alerts SET resolvedAt=? WHERE phoneId=? AND resolvedAt IS NULL',[this.now(),p.id]);
        });
    }
    async restoreBeforeDelete(job,p) {
        if(job.kind!=='release' || p.releaseReason!=='business_inactive'
            || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[p.businessId])) return false;
        // compensate can include an interrupted host removal. Restore and read
        // back the existing endpoint before returning the DID to active service.
        await this.fenced(job,()=>this.host.apply(p,Vault.decrypt(p.encryptedCredentials,p)));
        if((await this.fenced(job,()=>this.host.status(p))).registered!==true) {
            this.defer(job,'TELEPHONY_SIP_REGISTERING');return true;
        }
        return this.cancelRestoredRelease(job,p);
    }
    async deleteResources(job,p,compensation) {
        if(job.stage==='compensate') {
            if(await this.restoreBeforeDelete(job,p)) return;
            if(!await this.purchased(p,job)) {this.manual(job,'TELEPHONY_RELEASE_OWNERSHIP_UNKNOWN',p);return;}
            if(p.sipResourceId) {
                const sip=await this.fenced(job,()=>this.provider.sip(p.sipResourceId));
                if(sip.application_uuid!==p.applicationId || sip.sip_name!==p.sipName || String(sip.attributes?.cli)!==p.number)
                    {this.manual(job,'TELEPHONY_RELEASE_SCOPE_INVALID',p);return;}
            }
            await this.fenced(job,()=>this.host.remove(p));
            if(await this.restoreBeforeDelete(job,p)) return;
            this.advance(job,'delete_sip_dispatching');
            if(p.sipResourceId) await this.fenced(job,()=>this.provider.deleteSip(p.sipResourceId));
            this.advance(job,'delete_sip_confirm');
        }
        if(['delete_sip_dispatching','delete_sip_confirm'].includes(job.stage)) {
            if(p.sipResourceId && (await this.fenced(job,()=>this.provider.sips())).some(r=>String(r.sip_resource_id)===p.sipResourceId))
                {this.defer(job,'TELEPHONY_DELETE_SIP_RECONCILING',30000);return;}
            this.advance(job,'delete_number_dispatching');
            await this.fenced(job,()=>this.provider.deleteNumber(p.number));
            this.advance(job,'delete_number_confirm');
        }
        if(['delete_number_dispatching','delete_number_confirm'].includes(job.stage)) {
            if(await this.purchased(p,job)) {this.defer(job,'TELEPHONY_DELETE_RECONCILING',30000);return;}
            Store.transaction(()=>{
                this.advance(job,compensation?'failed':'released',{state:compensation?'failed':'done',errorCode:compensation?job.errorCode:null});
                DB.run("UPDATE ava_phone_numbers SET state='released',isPrimary=0,inboundReady=0,outboundReady=0,encryptedCredentials=NULL,updatedAt=? WHERE id=?",[this.now(),p.id]);
                DB.run('DELETE FROM business_sip_aliases WHERE alias=? AND businessId=?',[p.number,p.businessId]);
                const i=DB.get('SELECT sipAliases FROM instances WHERE id=?',[p.businessId]);
                DB.run('UPDATE instances SET sipAliases=? WHERE id=?',[JSON.stringify(JSON.parse(i.sipAliases || '[]').filter(n=>n!==p.number)),p.businessId]);
                const replacement=DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state='active' ORDER BY createdAt LIMIT 1",[p.businessId]);
                if(p.isPrimary && replacement) Store.primary(p.businessId,replacement.id);
                else if(p.isPrimary) DB.run('UPDATE instances SET sipCallerId=NULL,sipTrunkNumber=NULL WHERE id=?',[p.businessId]);
                if(!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[p.businessId])) {
                    const manual=DB.get('SELECT * FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);
                    if(manual) DB.run('UPDATE instances SET sipCallerId=?,sipTrunkNumber=? WHERE id=?',[manual.sipCallerId,manual.sipTrunkNumber,p.businessId]);
                    DB.run('DELETE FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);
                }
                Store.syncProjection(p.businessId);
                DB.run('UPDATE ava_phone_alerts SET resolvedAt=? WHERE phoneId=? AND resolvedAt IS NULL',[this.now(),p.id]);
            });
        }
    }
    async maintenance() {
        const now=this.now();
        await require('./external-sip').maintenance(this);
        Store.transaction(()=>{
            DB.run('DELETE FROM ava_phone_quotes WHERE expiresAt<?',[now-86400000]);
            // Deactivation may precede migration. Preserve the original deadline once set.
            DB.run(`UPDATE ava_phone_numbers SET state='grace',releaseAt=?,releaseReason='business_inactive',generation=generation+CASE WHEN origin='external' THEN 0 ELSE 1 END
                WHERE state='active' AND businessId IN (SELECT id FROM instances WHERE isActive=0)`,[now+LIMITS.graceMs]);
            for(const {businessId} of DB.all("SELECT DISTINCT businessId FROM ava_phone_numbers WHERE state<>'released'")) Store.restoreBusiness(businessId,now);
            DB.run("UPDATE ava_phone_alerts SET resolvedAt=? WHERE code='TELEPHONY_RELEASE_WARNING' AND resolvedAt IS NULL AND phoneId IN (SELECT id FROM ava_phone_numbers WHERE state='active')",[now]);
            for(const p of DB.all("SELECT * FROM ava_phone_numbers WHERE state='grace' AND releaseAt<=? AND warningAt IS NULL",[now+LIMITS.warningMs])) {
                Store.alert('TELEPHONY_RELEASE_WARNING',p,now);DB.run('UPDATE ava_phone_numbers SET warningAt=? WHERE id=?',[now,p.id]);
            }
            for(const p of DB.all("SELECT * FROM ava_phone_numbers WHERE state='grace' AND releaseAt<=?",[now])) {
                DB.run("UPDATE ava_phone_numbers SET state='releasing',inboundReady=0,outboundReady=0 WHERE id=?",[p.id]);
                Store.insertOperation({businessId:p.businessId,phoneId:p.id,kind:'release',stage:'release_check',now});
                Store.syncProjection(p.businessId);
            }
        });
        try {const health=await this.host.health();Store.setMeta('telephony_health',{ingressReady:health.ingressReady===true,recordingReady:health.recordingReady===true},now);}
        catch(_) {Store.setMeta('telephony_health',{ingressReady:false,recordingReady:false},now);}
        const configured=this.provider.token && this.provider.applicationId;
        // Optional existing Web Push delivery. No key generation and no user
        // email/telephone side effects are introduced by the worker.
        if(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
            for(const a of DB.all("SELECT * FROM ava_phone_alerts WHERE code='TELEPHONY_RELEASE_WARNING' AND businessId IS NOT NULL AND notifiedAt IS NULL LIMIT 10")) {
                const claimed=DB.run('UPDATE ava_phone_alerts SET notifiedAt=? WHERE id=? AND notifiedAt IS NULL',[now,a.id]);
                if(claimed.changes) {
                    try {await require('../push.service').sendToAll(a.businessId,{type:'telephony_release',title:'Номер будет освобождён через 3 дня',
                        body:'Проверьте телефонию бизнеса в AVA. До освобождения отключение можно отменить.',url:'/channels?channel=telephony'});}
                    catch(_) {DB.run('UPDATE ava_phone_alerts SET notifiedAt=NULL WHERE id=?',[a.id]);}
                }
            }
        }
        if(!configured) return;
        // Independent maintenance work must still run when balance refresh fails.
        try {await this.balance();} catch(_) {Store.alert('TELEPHONY_BALANCE_UNAVAILABLE',null,now);}
        const last=Store.meta('reconciliation');
        try {if(!last || last.updatedAt<now-86400000) {
            const {numbers:inventory,sips}=await Existing.inventory(this);
            const known=DB.all("SELECT * FROM ava_phone_numbers WHERE state<>'released'");
            for(const row of inventory) if(!known.some(p=>p.number===String(row.number_name)))
                Store.alert('TELEPHONY_UNASSIGNED_PROVIDER_NUMBER',{id:String(row.number_name)},now);
            for(const p of known.filter(p=>p.state==='active'&&p.origin!=='external')) {
                const r=inventory.find(r=>String(r.number_name)===p.number && r.application_uuid===p.applicationId);
                const sip=sips.find(s=>String(s.sip_resource_id)===p.sipResourceId && s.application_uuid===p.applicationId && String(s.cli)===p.number && s.sip_name===p.sipName);
                const inboundOnly=p.origin==='existing' && DB.get("SELECT phoneId FROM ava_phone_existing_profiles WHERE phoneId=? AND mode='inbound_only'",[p.id]);
                if(!r || !forwardingMatches(r,p,staticTarget()) || (!inboundOnly && !sip)) {
                    DB.run("UPDATE ava_phone_numbers SET state='manual',inboundReady=0,outboundReady=0 WHERE id=? AND state='active'",[p.id]);
                    Store.alert('TELEPHONY_ROUTING_DRIFT',p,now);
                    Store.syncProjection(p.businessId);
                }
                if(r && sip) {
                    try {
                        if(kopecks(r.install_fee)+kopecks(sip.install_fee)!==p.installKopecks
                            || kopecks(r.subscription_fee)+kopecks(sip.subscription_fee)!==p.monthlyKopecks)
                            Store.alert('TELEPHONY_PRICE_DRIFT',p,now);
                    } catch(_) {Store.alert('TELEPHONY_PRICE_CHECK_UNAVAILABLE',p,now);}
                }
            }
            for(const sip of sips.filter(s=>String(s.sip_name || '').startsWith('ava_')))
                if(!known.some(p=>p.sipResourceId===String(sip.sip_resource_id) || p.sipName===sip.sip_name)) Store.alert('TELEPHONY_UNASSIGNED_SIP_RESOURCE',{id:String(sip.sip_resource_id)},now);
            Store.setMeta('reconciliation',{count:inventory.length},now);
        }} catch(_) {Store.alert('TELEPHONY_RECONCILIATION_UNAVAILABLE',null,now);}
        const stale=DB.all("SELECT * FROM ava_phone_calls WHERE state='reserved' AND createdAt<?",[now-420000]);
        try {if(stale.length && (await this.host.calls()).active===0) {
            for(const call of stale) Store.finishCall(call.id,{businessId:call.businessId,seconds:call.reservedSeconds},now);
        }} catch(_) {Store.alert('TELEPHONY_CALL_RECOVERY_UNAVAILABLE',null,now);}
    }
}
module.exports=new PhoneWorker();
module.exports.PhoneWorker=PhoneWorker;
module.exports.prices=prices;
module.exports.forwardingMatches=forwardingMatches;
module.exports.staticTarget=staticTarget;
