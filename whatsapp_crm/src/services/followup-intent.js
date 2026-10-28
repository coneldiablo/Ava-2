'use strict';

const patterns = {
    whatsapp: /(?:whats?\s*app|ватс?\s*ап|вацап|васап)/iu,
    telegram: /(?:telegram|телеграм|телегу|телег[еу]|(?:^|[^\p{L}])тг(?:$|[^\p{L}]))/iu,
    email: /(?:e-?mail|имейл|электронн.{0,12}почт|на\s+почт|по\s+почт)/iu,
    vk: /(?:вконтакте|в\s+контакте|(?:^|[^\p{L}])(?:vk|вк)(?:$|[^\p{L}]))/iu,
    max: /(?:^|[^\p{L}])(?:max|макс)(?:$|[^\p{L}])/iu,
    avito: /(?:avito|авито)/iu,
    instagram: /(?:instagram|инстаграм|в\s+инст[еу])/iu,
};
const guest = /^(?:user|caller|guest|human|customer|client|клиент|гость|пользователь)$/iu;
const assistant = /^(?:assistant|agent|ассистент|ава|ava)$/iu;
const labels = /(?:^|\n)(user|caller|guest|human|customer|client|клиент|гость|пользователь|assistant|agent|ассистент|ава|ava|system)\s*:/giu;
const named = text => Object.entries(patterns).filter(([,pattern]) => pattern.test(text)).map(([channel]) => channel);
const request = /(?:пришл(?:ите|и)|прислать|отправ(?:ьте|ь|ить|ляй|ляйте)|скинь(?:те)?|вышл(?:ите|и)|выслать|напиш(?:ите|и)|написать|пишите)/iu;
const refusal = /(?:не\s+(?:надо|нужно|присыла|отправля|отправь|пришл|пиш|хочу)|не\s+в\s|^(?:нет|неа)(?:\s|[,.!?]|$))/iu;
const defer = /(?:для\s+начала|(?:^|\s)сначала\s|пока\s+не|потом\s+решим|не\s+сейчас)/iu;
const acceptance = /^(?:да(?:вайте)?|ага|хорошо|согласен|согласна|можно|конечно|отправляйте|присылайте)(?:[,\s]+пожалуйста)?[.!\s]*$/iu;

function turns(value) {
    if (Array.isArray(value)) return value.filter(v => v && typeof v === 'object')
        .map(v => ({role:String(v.role || v.speaker || ''),text:String(v.content || v.text || v.transcript || '')}));
    if (typeof value !== 'string') return [];
    const matches = [...value.matchAll(labels)];
    if (!matches.length) return [{role:'user',text:value}]; // Legacy guest-only payload.
    return matches.map((m,i) => ({role:m[1],text:value.slice(m.index+m[0].length,matches[i+1]?.index ?? value.length)}));
}

// Consent comes from ordered caller turns. An assistant offer alone never
// authorizes a send; an adjacent short answer can accept a specific offer.
function requestedChannels(value) {
    const selected = new Set();
    let offer = null, wantsSend = false;
    for (const turn of turns(value)) {
        const text = turn.text.trim().toLowerCase();
        if (assistant.test(turn.role)) {
            offer = !/(?:не\s+(?:могу|буду|отправ|пришл|предлага))/iu.test(text) && /(?:отправ|пришл|присла|высл|скин|напиш|удобнее|куда|мессенджер)/iu.test(text) ? named(text) : null;
            continue;
        }
        if (!guest.test(turn.role)) { offer = null; continue; }
        const offered = offer; offer = null;
        const names = named(text);
        if (defer.test(text)) { selected.clear(); wantsSend=false; continue; }
        const sentences = text.split(/[.!?;\n]+|,\s*(?=(?:а\s|но\s|лучше\s|отправ|пришл|присла|скинь|вышл|напиш))/iu);
        for (const sentence of sentences) {
            const channels = named(sentence);
            if (refusal.test(sentence)) {
                if (channels.length) channels.forEach(c => selected.delete(c)); else selected.clear();
                wantsSend=false;
            } else if (request.test(sentence)) {
                if (/(?:лучше|вместо|только)/iu.test(sentence)) selected.clear();
                channels.forEach(c => selected.add(c)); wantsSend=true;
            }
        }
        if (!refusal.test(text) && !request.test(text)) {
            const shortChoice = names.length===1 && text.length<=65 && !/[?？]/u.test(text)
                && /^(?:лучше\s+|да[,\s]+|давайте\s+|в\s+|на\s+)?(?:whats?\s*app|ватс?\s*ап|вацап|васап|telegram|телеграм\p{L}*|телег[еу]|тг|почт\p{L}*|e-?mail|имейл|вконтакте|вк|vk|max|макс|avito|авито|instagram|инстаграм)(?:[,\s]+(?:пожалуйста|да|давай(?:те)?|удобнее|подойд[её]т))*[.!\s]*$/iu.test(text);
            if (shortChoice && (wantsSend || offered?.includes(names[0]))) {
                selected.clear(); selected.add(names[0]); wantsSend=true;
            } else if (acceptance.test(text) && offered?.length===1) {
                selected.clear(); selected.add(offered[0]); wantsSend=true;
            } else if (acceptance.test(text) && offered?.length===0) {
                wantsSend=true; // Accepted material first; select the channel next.
            }
        }
    }
    return [...selected];
}

module.exports={requestedChannels};
