import { api } from '../api';
export type Phone = {origin?:'managed'|'existing'|'external';id:string;number:string;state:string;isPrimary:number;installKopecks:number;monthlyKopecks:number;
    inboundReady:number;outboundReady:number;inboundVerifiedAt:number|null;outboundVerifiedAt:number|null;releaseAt:number|null;warningAt:number|null};
export type Quote = {id:string;number:string;installKopecks:number;monthlyKopecks:number;expiresAt:number};
export type Catalog = {types:{type_id:number;type_name:string}[];regions:{id:number;name:string}[]};
export type Operation = {id:string;phoneId:string|null;kind:string;stage:string;state:string;errorCode:string|null;
    result:({quotes?:Quote[]} & Partial<Catalog>)|null};
export type SipTransport = 'udp'|'tcp'|'tls';
export type ExternalSipInput = {number:string;host:string;port:number;transport:SipTransport;login:string;password:string};
export type ExternalSipTrunk = {id:string;number:string;host:string;port:number;transport:SipTransport;loginMasked:string;passwordConfigured:boolean;
    revision:number;state:string;registration:'unknown'|'unregistered'|'registered';inboundVerifiedAt:number|null;outboundVerifiedAt:number|null;lastErrorCode?:string|null;operationId?:string|null};
export type Telephony = {success:boolean;businessId?:number;canManage:boolean;canPurchase:boolean;canImport?:boolean;managedMode:boolean;pilotEnabled:boolean;balanceReady:boolean;health?:{ingressReady:boolean;recordingReady:boolean;checkedAt:number}|null;
    externalSip?:{available:boolean;transports:SipTransport[];blocker?:string|null};externalTrunks?:ExternalSipTrunk[];
    connectionPaths?:{kind:string;configured?:boolean;canImport?:boolean;canPurchase?:boolean;blocker?:string|null}[];
    connections?:{id:string;kind:string;number:string;businessId:number;state:string;inbound:{configured:boolean;available:boolean|null;verifiedAt:number|null};outbound:{configured:boolean;available:boolean|null;verifiedAt:number|null}}[];diagnostics?:{checks:{code:string;state:string}[]};
    numbers:Phone[];orders:Operation[];remainingSeconds:number;limits:{numbers:number;dailySeconds:number};notices:{code:string;phoneId:string}[]};
const base=(id:number)=>`/businesses/${id}/telephony`;
export const getTelephony=(id:number,signal?:AbortSignal)=>api.get(base(id),{signal,timeout:15000}).then(r=>r.data as Telephony);
export const getPhoneCatalog=(id:number,signal?:AbortSignal)=>api.get(base(id)+'/catalog',{signal,timeout:15000}).then(r=>r.data as Partial<Catalog> & {operation?:Operation});
export const findPhones=(id:number,typeId:number,regionId:number,signal?:AbortSignal)=>api.post(base(id)+'/quotes',{typeId,regionId},{signal,timeout:15000}).then(r=>r.data.operation as Operation);
export const getPhoneOperation=(id:number,op:string,signal?:AbortSignal)=>api.get(base(id)+'/orders/'+encodeURIComponent(op),{signal,timeout:15000}).then(r=>r.data.operation as Operation);
export const buyPhone=(id:number,quoteId:string,key:string,signal?:AbortSignal)=>api.post(base(id)+'/orders',{quoteId},{signal,timeout:15000,headers:{'Idempotency-Key':key}}).then(r=>r.data.operation as Operation);
export const setPrimaryPhone=(id:number,phoneId:string,signal?:AbortSignal)=>api.put(base(id)+'/primary',{phoneId},{signal,timeout:15000});
export const releasePhone=(id:number,phoneId:string,cancel=false,signal?:AbortSignal)=>api.post(base(id)+'/numbers/'+encodeURIComponent(phoneId)+(cancel?'/cancel-release':'/release'),{},{signal,timeout:15000});

export type ExistingMode = 'sip' | 'inbound_only';
export type ExistingCandidate = {number:string;modes:ExistingMode[];monthlyKopecks:number|null;alreadyBound:boolean;forwardingReady?:boolean;sipAvailable?:boolean;blockers?:string[]};
export type ExistingInventory = {success:boolean;candidates:ExistingCandidate[];operation?:Operation;updatedAt?:number};
export type ExistingImport = {number:string;mode:ExistingMode;confirmUnused:true};
// Existing-resource binding is a separate customer contract; it never calls the purchase routes.
const existingBase=base;
export const getExistingPhones=(id:number,signal?:AbortSignal)=>api.get(existingBase(id)+'/existing',{signal,timeout:15000}).then(r=>r.data as ExistingInventory);
export const importExistingPhone=(id:number,input:ExistingImport,key:string,signal?:AbortSignal)=>api.post(existingBase(id)+'/imports',input,
    {signal,timeout:15000,headers:{'Idempotency-Key':key}}).then(r=>r.data.operation as Operation);
export const getExistingPhoneOperation=getPhoneOperation;
export const createExternalSip=(id:number,input:ExternalSipInput,key:string,signal?:AbortSignal)=>api.post(base(id)+'/external',input,
    {signal,timeout:15000,headers:{'Idempotency-Key':key}}).then(r=>r.data.operation as Operation);
export const updateExternalSip=(id:number,phoneId:string,input:Partial<ExternalSipInput>&{expectedRevision:number},key:string,signal?:AbortSignal)=>api.put(base(id)+'/external/'+encodeURIComponent(phoneId),input,
    {signal,timeout:15000,headers:{'Idempotency-Key':key}}).then(r=>r.data.operation as Operation);
export const checkExternalSip=(id:number,phoneId:string,revision:number,key:string,signal?:AbortSignal)=>api.post(base(id)+'/external/'+encodeURIComponent(phoneId)+'/check',{expectedRevision:revision},
    {signal,timeout:15000,headers:{'Idempotency-Key':key}}).then(r=>r.data.operation as Operation);
export const disconnectExternalSip=(id:number,phoneId:string,revision:number,key:string,signal?:AbortSignal)=>api.post(base(id)+'/external/'+encodeURIComponent(phoneId)+'/disconnect',{expectedRevision:revision},
    {signal,timeout:15000,headers:{'Idempotency-Key':key}}).then(r=>r.data.operation as Operation);
export const getExternalSipRequest=(id:number,key:string,signal?:AbortSignal)=>api.get(base(id)+'/external/requests/'+encodeURIComponent(key),{signal,timeout:15000})
    .then(r=>r.data as {success:boolean;businessId:number;operation:Operation|null});
export type ManualPhones = {inboundNumbers:string[];outboundNumber:string|null};
export const getManualPhones=(id:number,signal?:AbortSignal)=>api.get(`/hotel-profiles/${id}`,{signal,timeout:15000}).then(r=>{
    const profile=r.data?.profile;
    if(!r.data?.success || !profile)throw new Error('manual profile unavailable');
    const isPhone=(value:unknown):value is string=>typeof value==='string' && /^\+?\d[\d ()-]{6,20}$/.test(value);
    return {inboundNumbers:Array.isArray(profile.sipAliases)?profile.sipAliases.filter(isPhone):[],
        outboundNumber:isPhone(profile.sipCallerId)?profile.sipCallerId:null} as ManualPhones;
});
