'use strict';
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const MAX_LINKS = 12;
const MAX_BYTES = 512 * 1024;
const PAGE_TIMEOUT = 6000;
const TOTAL_TIMEOUT = 20000;
let activeBatches=0;
const denied = new net.BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3],['192.88.99.0',24]]) denied.addSubnet(ip,prefix,'ipv4');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
const deniedV6 = new net.BlockList();
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) deniedV6.addSubnet(ip,prefix,'ipv6');
function isPublicAddress(ip) {
 const family = net.isIP(ip);
 return family === 4 ? !denied.check(ip,'ipv4') : family === 6 && globalV6.check(ip,'ipv6') && !deniedV6.check(ip,'ipv6');
}
function normalizeLinks(links) {
 if (!Array.isArray(links) || links.length > MAX_LINKS) throw new Error('Provide up to 12 public http(s) links');
 const result=[];
 for (const item of links) {
  if (typeof item !== 'string' || item.length > 2048) throw new Error('Invalid public link');
  let u; try { u=new URL(item.trim()); } catch { throw new Error('Invalid public link'); }
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port))) throw new Error('Only public http(s) links without credentials or custom ports are allowed');
  const hostname=u.hostname.replace(/^\[|\]$/g,'');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || (net.isIP(hostname) && !isPublicAddress(hostname))) throw new Error('Private or local addresses are not allowed');
  u.hash=''; if (!result.includes(u.href)) result.push(u.href);
 }
 return result;
}
function decode(s) { return s.replace(/&#(x[\da-f]+|\d+);/gi,(_,v)=>{ const n=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):Number(v); return n>0&&n<=0x10ffff?String.fromCodePoint(n):' '; }).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi,(_,v)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[v.toLowerCase()]); }
function plain(s) { return decode(s.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(); }
function extractContent(html) {
 const title=plain((html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)||[])[1]||'').slice(0,300);
 const metadata=[];
 for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
  const attrs={}; for (const a of m[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1].toLowerCase()]=a[2]??a[3]??a[4];
  if (/^(description|og:title|og:description|twitter:title|twitter:description)$/i.test(attrs.name||attrs.property||'') && attrs.content) metadata.push(plain(attrs.content));
 }
 const structured=[];
 for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
  try { const value=JSON.parse(m[1]); structured.push(JSON.stringify(value).slice(0,12000)); } catch { /* malformed public data */ }
 }
 const visible=plain(html.replace(/<([a-z][\w:-]*)\b[^>]*(?:\shidden(?:\s|=|>)|aria-hidden\s*=\s*["']true["']|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden))[^>]*>[^]*?<\/\1\s*>/gi,' ').replace(/<!--[^]*?-->/g,' ').replace(/<(script|style|noscript|template|svg)\b[^>]*>[^]*?<\/\1\s*>/gi,' '));
 const login=/<input\b[^>]*type\s*=\s*(?:["']password["']|password(?:\s|>))/i.test(html) || /^(log\s*in|sign\s*in|login|вход|авторизац)/i.test(title) || /(?:accounts\/login|login_required|checkpoint\/)/i.test(html.slice(0,20000)) || (visible.length<1200 && /(?:log in to|sign in to|войдите,? чтобы|войдите в аккаунт|access denied|enable javascript|verify you are human)/i.test(visible));
 const text=[...metadata,...structured,visible].join('\n').slice(0,18000);
 return {title,text:login||text.length<80?'':text};
}
async function readPage(url, options, deadline, redirects=0) {
 if (redirects>3) throw new Error('redirect limit');
 if(options.signal?.aborted) throw new Error('aborted');
 const u=new URL(normalizeLinks([url])[0]);
 const hostname=u.hostname.replace(/^\[|\]$/g,'');
 const remaining=Math.min(PAGE_TIMEOUT,deadline-Date.now());
 if (remaining<=0) throw new Error('timeout');
 const expires=Date.now()+remaining;
 let timer,abortListener;
 const aborted=new Promise((_,reject)=>{if(options.signal){abortListener=()=>reject(new Error('aborted'));options.signal.addEventListener('abort',abortListener,{once:true});}});
 try {
  return await Promise.race([aborted,new Promise((resolve,reject)=>{ timer=setTimeout(()=>reject(new Error('timeout')),remaining); }), (async()=>{
   const addresses=net.isIP(hostname)?[{address:hostname,family:net.isIP(hostname)}]:await (options.lookup||dns.lookup)(hostname,{all:true,verbatim:true});
   if (!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) throw new Error('non-public DNS');
   if (options.signal?.aborted) throw new Error('aborted');
   if (Date.now()>=expires) throw new Error('timeout');
   const pinned=addresses[0];
   return await new Promise((resolve,reject)=>{
    const request=(options.request || (u.protocol==='https:'?https.request:http.request));
    const req=request(u,{method:'GET',agent:false,headers:{'User-Agent':'AVA-PublicPageReader/1.0','Accept':'text/html,application/xhtml+xml,text/plain','Accept-Encoding':'identity'},lookup:(_h,lookupOptions,cb)=>lookupOptions?.all ? cb(null,[{address:pinned.address,family:pinned.family}]) : cb(null,pinned.address,pinned.family)},res=>{
     if ([301,302,303,307,308].includes(res.statusCode)) { const location=res.headers.location; res.destroy(); if (!location) return reject(new Error('missing redirect')); return resolve({redirect:new URL(location,u).href}); }
     if (res.statusCode<200||res.statusCode>=300 || !/^(text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i.test(res.headers['content-type']||'') || (res.headers['content-encoding'] && res.headers['content-encoding']!=='identity') || Number(res.headers['content-length']||0)>MAX_BYTES) { res.destroy(); return reject(new Error('unavailable content')); }
     let size=0; const chunks=[];
     res.on('data',chunk=>{size+=chunk.length;if(size>MAX_BYTES){res.destroy();reject(new Error('page too large'));}else chunks.push(chunk);});
     res.on('error',reject);res.on('end',()=>resolve({html:Buffer.concat(chunks).toString('utf8')}));
    });
    const abortRequest=()=>req.destroy(new Error('aborted'));
    options.signal?.addEventListener('abort',abortRequest,{once:true});
    const timeout=setTimeout(()=>req.destroy(new Error('timeout')),Math.max(1,expires-Date.now()));
    req.on('close',()=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',abortRequest);});req.on('error',reject);if(options.signal?.aborted)abortRequest();else req.end();
   });
  })()]);
 } finally {clearTimeout(timer);if(abortListener)options.signal.removeEventListener('abort',abortListener);}
}
async function extractPages(links, options={}) {
 const normalized=normalizeLinks(links), results=new Array(normalized.length), deadline=Date.now()+TOTAL_TIMEOUT;
 if(activeBatches>=2) throw Object.assign(new Error('Сервис подготовки инструкций занят. Повторите позже.'), {statusCode:429,code:'EXTRACTION_CAPACITY',publicMessage:'Сервис подготовки инструкций занят. Повторите позже.'});
 activeBatches++;
 let next=0;
 async function fetchContent(url) {
  let current=url,result;
  for(let hop=0;hop<=3;hop++) {
   result=await readPage(current,options,deadline,hop);
   if(!result.redirect) return {url:current,html:result.html,...extractContent(result.html)};
   current=result.redirect;
  }
  throw new Error('redirect limit');
 }
 function telegramAlternate(url) {
  const parsed=new URL(url);
  if(parsed.hostname!=='t.me' || parsed.search || !/^\/[a-z][a-z0-9_]{4,31}\/?$/i.test(parsed.pathname)) return null;
  const username=parsed.pathname.replace(/\//g,'');
  if(/^(joinchat|share|addlist|proxy|socks|login|confirmphone|setlanguage|boost|instantview|gift|business|contact|invoice)$/i.test(username)) return null;
  return `https://t.me/s/${username}`;
 }
 async function worker() {
  while(next<normalized.length) {
   const index=next++,url=normalized[index];
   let content;
   try {content=await fetchContent(url);} catch {content={url,title:'',text:''};}
   const alternate=telegramAlternate(url);
   if(alternate && !options.signal?.aborted && Date.now()<deadline) {
    try {
     const publicPosts=await fetchContent(alternate);
     if(publicPosts.text && /tgme_widget_message_text|js-message_text/i.test(publicPosts.html)) content=publicPosts;
    } catch { /* retain the actual profile observation if public posts are unavailable */ }
   }
   results[index]={url:content.url,title:content.title,status:content.text?'read':'unavailable',text:content.text};
  }
 }

 try {await Promise.all(Array.from({length:Math.min(3,normalized.length)},worker));return results;} finally {activeBatches--;}
}
module.exports={normalizeLinks,extractPages,isPublicAddress,extractContent};
