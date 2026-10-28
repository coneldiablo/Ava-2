"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OMITTED_MEDIA = exports.MEDIA_MESSAGE_TYPES = void 0;
exports.buildMessageMetadata = buildMessageMetadata;
exports.storableWaMessageId = storableWaMessageId;
exports.MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);
exports.OMITTED_MEDIA = { mimetype: '', omitted: true };
function buildMessageMetadata(message, synthesizeOmittedMedia = false) {
    const metadata = {};
    if (message.media) {
        metadata.media = message.media;
    }
    else if (synthesizeOmittedMedia && exports.MEDIA_MESSAGE_TYPES.has(message.type)) {
        metadata.media = { ...exports.OMITTED_MEDIA };
    }
    if (message.quotedMessage) {
        metadata.quotedMessage = message.quotedMessage;
    }
    if (message.call) {
        metadata.call = message.call;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
}
function storableWaMessageId(id) {
    return id || undefined;
}
//# sourceMappingURL=message-row.mapper.js.map