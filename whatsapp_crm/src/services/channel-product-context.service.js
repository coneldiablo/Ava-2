'use strict';
// Product identity belongs to the natural channel origin, never a merged client.
const DB = require('./database.service');
const {createHash} = require('crypto');
const initialized = new WeakSet();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 300) => ['string','number'].includes(typeof value)
    ? String(value).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max) || null : null;
const equal = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replace(/\s+/g,' ').trim();
function fail(code) { throw Object.assign(new Error(code), {code, statusCode:409, safeToRetry:true}); }
function ensureSchema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS channel_product_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, accountId TEXT NOT NULL, originChatId TEXT NOT NULL,
        providerMessageId TEXT NOT NULL, messageSourceId TEXT NOT NULL, entryJson TEXT NOT NULL, observedAt TEXT NOT NULL, requiresMessage INTEGER NOT NULL DEFAULT 0,
        UNIQUE(businessId,channel,accountId,originChatId,providerMessageId));
        CREATE INDEX IF NOT EXISTS idx_channel_product_origin ON channel_product_entries(businessId,channel,accountId,originChatId,id);`);
    initialized.add(DB.db);
}
function normalize(value = {}, provenance = value.provenance) {
    if (!value || typeof value !== 'object') return null;
    const entry = {
        productId:text(value.productId || value.id,120), title:text(value.title || value.name,300),
        description:text(value.description,2000), url:text(value.url || value.sourceUrl,1000),
        quotedPrice:text(value.quotedPrice || value.price || value.price_string,120), currency:text(value.currencyCode || value.currency,12),
        merchantId:text(value.businessOwnerJid || value.merchantId,160),
        clickId:text(value.ctwaClid || value.clickId,160), sourceType:text(value.sourceType,60), sourceApp:text(value.sourceApp,60),
        provenance:['provider_owned_listing','customer_product','customer_referral','customer_quote'].includes(provenance) ? provenance : 'customer_product',
    };
    return entry.productId || entry.title || entry.url ? entry : null;
}
function greenEntry(data = {}) {
    if (data.productMessage) return normalize(data.productMessage,'customer_product');
    const ad=data.extendedTextMessageData;
    if (ad && (ad.sourceId || ad.sourceUrl)) return normalize({...ad,productId:ad.sourceId,url:ad.sourceUrl},'customer_referral');
    const quote=data.quotedMessage;
    if (quote?.productMessage) return normalize(quote.productMessage,'customer_quote');
    if (quote?.extendedTextMessageData?.sourceId || quote?.extendedTextMessageData?.sourceUrl) {
        const value=quote.extendedTextMessageData;
        return normalize({...value,productId:value.sourceId,url:value.sourceUrl},'customer_quote');
    }
    return null;
}
function openwaEntry(data = {}) {
    if (data.product) return normalize(data.product,'customer_product');
    if (data.quotedMessage?.product) return normalize(data.quotedMessage.product,'customer_quote');
    if (data.quotedMsg?.product) return normalize(data.quotedMsg.product,'customer_quote');
    return null;
}
function avitoEntry(chat) { return chat?.context?.type === 'item' || chat?.context?.value?.id
    ? normalize(chat.context.value,'provider_owned_listing') : null; }
function accountIds(instance, channel) {
    if (channel === 'avito') {
        const row=require('./integrations/store').get(instance.id,'avito');
        return row?.accountId ? [String(row.accountId)] : [];
    }
    return [instance.openWaSessionId ? 'openwa:'+instance.openWaSessionId : null,
        instance.greenApiInstance ? 'green_api:'+instance.greenApiInstance : null].filter(Boolean);
}
function record(input) {
    const businessId=Number(input.businessId);
    if (!Number.isSafeInteger(businessId) || businessId < 1 || !['whatsapp','avito'].includes(input.channel)) fail('PRODUCT_SCOPE_INVALID');
    const originChatId=text(input.originChatId,200),accountId=text(input.accountId,200),providerMessageId=text(input.providerMessageId,256),entry=normalize(input.entry);
    if (!entry || !originChatId || !accountId || !providerMessageId) return null;
    if (!DB.get('SELECT 1 FROM instances WHERE id=?',[businessId])) fail('PRODUCT_SCOPE_INVALID');
    ensureSchema();
    DB.run(`INSERT INTO channel_product_entries(businessId,channel,accountId,originChatId,providerMessageId,messageSourceId,entryJson,observedAt,requiresMessage)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(businessId,channel,accountId,originChatId,providerMessageId) DO NOTHING`,
    [businessId,input.channel,accountId,originChatId,providerMessageId,text(input.messageSourceId,256)||providerMessageId,JSON.stringify(entry),new Date().toISOString(),input.requiresMessage?1:0]);
    return DB.get('SELECT * FROM channel_product_entries WHERE businessId=? AND channel=? AND accountId=? AND originChatId=? AND providerMessageId=?',
        [businessId,input.channel,accountId,originChatId,providerMessageId]);
}
function catalogFact(offer) { return {offerId:offer.id,revision:offer.revision,name:offer.name,description:offer.description,
    amountMinor:offer.amountMinor,currency:offer.currency,terms:offer.terms,availability:null,source:'published_catalog'}; }
function knowledgeSource(businessId,entry) {
    if (!DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_chunks'")) return {knowledgeFacts:[]};
    const rows=DB.all(`SELECT c.id,c.kbId,c.text,k.originalName,k.version FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId
        WHERE k.instanceId=? AND k.isCurrent=1 ORDER BY k.createdAt DESC,c.chunkIndex LIMIT 512`,[businessId]);
    const title=String(entry.title||'').normalize('NFKC').trim(),identifier=String(entry.productId||'');
    const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const titlePattern=title.length>=4 ? new RegExp('(?<![\\p{L}\\p{N}])'+title.split(/\s+/u).map(escape).join('\\s+')+'(?=[ \\t]*(?:[\\r\\n:;,.!?()—–|]|$))','giu') : null;
    const idPattern=identifier.length>=3 ? new RegExp('(?:артикул|sku|код\\s+товара|(?:avito|авито|product)\\s*(?:id|ид)|id\\s+товара)\\s*[:#№=-]?\\s*'+escape(identifier)+'(?=$|[^\\p{L}\\p{N}_-])','iu') : null;
    const matches=rows.flatMap(row=>{
        const raw=String(row.text),titles=titlePattern?[...raw.matchAll(titlePattern)]:[];
        const idMatch=idPattern?.exec(raw);
        // A provider ID in prose, an amount or a measurement is never an SKU.
        // When a card provides a title, require the same complete title too.
        const byId=!!idMatch&&(!title||titles.length>0);
        if(!byId&&!titles.length)return [];
        const anchor=titles[0]?.index ?? idMatch.index,start=raw.length<=2400?0:Math.max(0,anchor-60);
        return [{documentId:Number(row.kbId),chunkId:Number(row.id),title:row.originalName,version:row.version,
            text:raw.slice(start,start+2400),sourceComplete:start===0&&raw.length<=2400,
            source:'current_business_knowledge',contentHash:hash(raw),byId,repeatedTitle:titles.length>1}];
    });
    if(matches.some(row=>row.repeatedTitle)||matches.length>1&&!matches.every(row=>row.byId))return {knowledgeFacts:[],knowledgeAmbiguous:true};
    return {knowledgeFacts:matches.slice(0,3)};
}
function resolve(businessId,entry) {
    if (!entry) return {status:'none',facts:[]};
    const Catalog=require('./ava-autopilot.store'),offers=Catalog.offers(businessId);
    // An exact provider ID may also be an explicitly imported SKU. No substring
    // matching and no fallback to an unrelated sole offer is permitted here.
    let candidates=entry.productId ? offers.filter(offer => String(offer.id)===entry.productId) : [];
    if (!candidates.length && entry.productId && DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_catalog_keys'")) {
        const linked=DB.all('SELECT offerId FROM customer_catalog_keys WHERE businessId=? AND productKey=?',
            [businessId,'sku:'+equal(entry.productId)]);
        candidates=offers.filter(offer=>linked.some(row=>row.offerId===offer.id));
    }
    if (!candidates.length && entry.title) candidates=offers.filter(offer=>equal(offer.name)===equal(entry.title));
    if (candidates.length>1) return {status:'ambiguous',facts:[]};
    if (candidates.length===1) {
        if (!candidates[0].active || !candidates[0].publishedAt) return {status:'inactive',facts:[]};
        return {status:'resolved',facts:[catalogFact(candidates[0])]};
    }
    const knowledge=knowledgeSource(businessId,entry);
    return {status:knowledge.knowledgeAmbiguous?'ambiguous':knowledge.knowledgeFacts.length?'knowledge_grounded':entry.provenance==='provider_owned_listing'?'provider_listing':'unresolved',facts:[],...knowledge};
}
function snapshot(businessId,originChatId,options = {}) {
    businessId=Number(businessId);const channel=options.channel || 'whatsapp';
    const instance=DB.get('SELECT * FROM instances WHERE id=?',[businessId]);
    if (!instance || !['whatsapp','avito'].includes(channel)) fail('PRODUCT_SCOPE_INVALID');
    const canonical=require('./client-identity.service').resolve(businessId,originChatId);
    if (!DB.get('SELECT 1 FROM clients WHERE instanceId=? AND chatId=?',[businessId,canonical])) fail('PRODUCT_SCOPE_INVALID');
    const accounts=options.accountId ? [String(options.accountId)] : accountIds(instance,channel);
    ensureSchema();
    const row=accounts.length ? DB.get(`SELECT * FROM channel_product_entries WHERE businessId=? AND channel=? AND originChatId=?
        AND (requiresMessage=0 OR EXISTS(SELECT 1 FROM messages m WHERE m.instanceId=channel_product_entries.businessId
            AND m.originChatId=channel_product_entries.originChatId AND m.channel=channel_product_entries.channel
            AND m.role='user' AND m.sourceMessageId=channel_product_entries.messageSourceId))
        AND accountId IN (${accounts.map(()=>'?').join(',')}) ORDER BY id DESC LIMIT 1`,[businessId,channel,originChatId,...accounts]) : null;
    const entry=row?JSON.parse(row.entryJson):null,resolved=resolve(businessId,entry);
    return {businessId,channel,originChatId,accountId:row?.accountId || null,entryId:row?.id || null,
        observedAt:row?.observedAt || null,entry,...resolved,
        guard:hash({accountId:row?.accountId || null,entry,...resolved}), explicitAccount:options.accountId || null};
}
function assertCurrent(value) {
    if (!value) return;
    const current=snapshot(value.businessId,value.originChatId,{channel:value.channel,...(value.explicitAccount ? {accountId:value.explicitAccount}: {})});
    if (current.guard!==value.guard) fail('PRODUCT_CONTEXT_CHANGED');
}
function query(question,value,customerContext = null) {
    const identity=value?.facts?.[0];
    const oldNeed=customerContext?.priorDialogue?.messages?.filter(row=>/(нуж|хочу|важно|бюджет|требован|предпоч|не подходит)/i.test(row.text)).at(-1);
    const currentNeed=customerContext?.priorDialogue?.recentNeeds?.[0]||oldNeed;
    // The latest direct requirement supersedes stale summaries/older needs.
    // Negated clauses do not become positive search terms for a rejected option.
    const statements=currentNeed ? [currentNeed.text.split(/[.!?;,]/u).filter(clause=>!/(?:(?<![\p{L}\p{N}_])не\s+(?:нуж|над|подход|хоч)|больше\s+не|отказ|исключ)/iu.test(clause)).join(' ')] : customerContext?.customerMemory?.keyFacts?.slice(0,2)||[];
    // Prior customer needs affect ranking, never become product facts. Only a
    // bounded bag of words enters extractive retrieval, not model instructions.
    const remembered=statements.join(' ').slice(0,2400);
    const words=[...new Set(remembered.match(/[\p{L}\p{N}]{2,}/gu)||[])].slice(0,45).join(' ');
    return [String(question||'').slice(0,1000),identity?.name || value?.entry?.title,value?.entry?.productId,words].filter(Boolean).join(' ').slice(0,2000);
}
function knowledgeAnswer(value,question,customerContext) {
    if(!value?.knowledgeFacts?.length)return null;
    const RAG=require('./rag.service'),queryText=query(question,value,customerContext);
    const results=value.knowledgeFacts.map(fact=>({id:fact.chunkId,kbId:fact.documentId,text:fact.text,originalName:fact.title,score:1}));
    const selection=RAG._selectAnswerChunk(results,queryText);
    if(!selection?.matchedTokens?.length)return null;
    return {answer:RAG._voiceSnippet(selection,650),citations:[{document_id:String(selection.result.kbId),chunk_id:String(selection.result.id),title:selection.result.originalName}],missing_info:[]};
}
function clarify(value) {
    if (!value?.entry || ['resolved','provider_listing','knowledge_grounded'].includes(value.status)) return null;
    if(value.status==='ambiguous')return 'Подскажите, пожалуйста, какая модель или вариант товара вас интересует: в источниках несколько подходящих вариантов.';
    return value.status==='inactive' ? 'Информация об этом товаре сейчас требует подтверждения. Уточните, пожалуйста, какой вариант вам нужен?'
        : 'Уточните, пожалуйста, название или артикул товара: не удалось однозначно сопоставить присланную карточку с актуальным каталогом.';
}
module.exports={ensureSchema,normalize,greenEntry,openwaEntry,avitoEntry,record,snapshot,assertCurrent,query,clarify,catalogFact,hash,knowledgeAnswer};
