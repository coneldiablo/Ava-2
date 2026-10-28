"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapWwebjsMessageType = mapWwebjsMessageType;
exports.buildIncomingMessageBase = buildIncomingMessageBase;
exports.buildEditedMessage = buildEditedMessage;
exports.mapContactFields = mapContactFields;
const wa_id_1 = require("../identity/wa-id");
function mapWwebjsMessageType(raw) {
    switch (raw) {
        case 'chat':
            return 'text';
        case 'image':
            return 'image';
        case 'video':
            return 'video';
        case 'audio':
            return 'audio';
        case 'ptt':
            return 'voice';
        case 'document':
            return 'document';
        case 'sticker':
            return 'sticker';
        case 'location':
            return 'location';
        case 'vcard':
        case 'multi_vcard':
            return 'contact';
        case 'call_log':
            return 'call';
        case 'poll_creation':
            return 'poll';
        case 'revoked':
            return 'revoked';
        default:
            return 'unknown';
    }
}
function buildIncomingMessageBase(msg) {
    const chatId = msg.fromMe ? msg.to : msg.from;
    const incoming = {
        id: msg.id._serialized ?? msg.id.$1 ?? '',
        from: msg.from,
        to: msg.to,
        chatId,
        body: msg.body,
        type: mapWwebjsMessageType(msg.type),
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        isGroup: chatId.endsWith('@g.us'),
        kind: (0, wa_id_1.chatKind)(chatId),
        isStatusBroadcast: msg.to === 'status@broadcast' || chatId === 'status@broadcast',
    };
    if (msg.author) {
        incoming.author = msg.author;
    }
    if (msg.mentionedIds && msg.mentionedIds.length > 0) {
        incoming.mentionedIds = msg.mentionedIds;
    }
    const senderJid = msg.author ?? msg.from;
    if (senderJid.endsWith('@lid')) {
        incoming.isLidSender = true;
    }
    const pushName = msg._data?.notifyName;
    if (pushName) {
        incoming.contact = { pushName };
    }
    if (msg._data?.ephemeralDuration && msg._data.ephemeralDuration > 0) {
        incoming.ephemeralDuration = msg._data.ephemeralDuration;
    }
    return incoming;
}
function buildEditedMessage(message, hasMedia) {
    return {
        messageId: message.id,
        chatId: message.chatId,
        body: message.body,
        senderId: message.author ?? message.from,
        from: message.from,
        to: message.to,
        fromMe: message.fromMe,
        isGroup: message.isGroup,
        type: message.type,
        hasMedia,
        ...(message.author ? { author: message.author } : {}),
        ...(message.mentionedIds ? { mentionedIds: message.mentionedIds } : {}),
        timestamp: message.timestamp,
    };
}
function mapContactFields(contact, full = false) {
    const out = {};
    if (contact.name)
        out.name = contact.name;
    if (contact.pushname)
        out.pushName = contact.pushname;
    if (!full)
        return out;
    const id = contact.id?._serialized;
    if (id)
        out.id = id;
    if (contact.number)
        out.number = contact.number;
    if (contact.shortName)
        out.shortName = contact.shortName;
    if (contact.type)
        out.type = contact.type;
    if (contact.isMyContact !== undefined)
        out.isMyContact = contact.isMyContact;
    if (contact.isWAContact !== undefined)
        out.isWAContact = contact.isWAContact;
    if (contact.isBusiness !== undefined)
        out.isBusiness = contact.isBusiness;
    if (contact.isEnterprise !== undefined)
        out.isEnterprise = contact.isEnterprise;
    if (contact.verifiedName)
        out.verifiedName = contact.verifiedName;
    if (contact.verifiedLevel !== undefined)
        out.verifiedLevel = contact.verifiedLevel;
    if (contact.isBlocked !== undefined)
        out.isBlocked = contact.isBlocked;
    if (contact.labels && contact.labels.length > 0)
        out.labels = contact.labels;
    return out;
}
//# sourceMappingURL=message-mapper.js.map