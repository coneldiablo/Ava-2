"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WwebjsMessaging = void 0;
exports.wwebjsAckToDeliveryStatus = wwebjsAckToDeliveryStatus;
exports.extractWwebjsCall = extractWwebjsCall;
exports.declaredOnlyMedia = declaredOnlyMedia;
exports.isHttpUrl = isHttpUrl;
exports.loadRemoteMedia = loadRemoteMedia;
exports.isNoLidForUserError = isNoLidForUserError;
exports.isQuoteUnresolvedError = isQuoteUnresolvedError;
exports.toMessageMedia = toMessageMedia;
exports.toMessageResult = toMessageResult;
const whatsapp_web_js_1 = require("whatsapp-web.js");
const common_1 = require("@nestjs/common");
const message_not_found_error_1 = require("../../common/errors/message-not-found.error");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const load_remote_media_1 = require("../../common/media/load-remote-media");
const wa_id_1 = require("../identity/wa-id");
const inbound_media_cap_1 = require("./inbound-media-cap");
const message_mapper_1 = require("./message-mapper");
const vcard_1 = require("./vcard");
const engine_not_supported_error_1 = require("../../common/errors/engine-not-supported.error");
const recipient_unreachable_error_1 = require("../../common/errors/recipient-unreachable.error");
const wwebjs_host_1 = require("./wwebjs-host");
function wwebjsAckToDeliveryStatus(ack) {
    if (ack < 0)
        return 'failed';
    if (ack >= 3)
        return 'read';
    if (ack === 2)
        return 'delivered';
    if (ack === 1)
        return 'sent';
    return 'pending';
}
function extractWwebjsCall(msg) {
    if (msg.type !== 'call_log')
        return undefined;
    const d = msg._data ?? {};
    return { video: Boolean(d.isVideoCall), missed: !msg.fromMe && !d.callDuration };
}
function declaredOnlyMedia(msg) {
    const data = msg._data;
    return {
        mimetype: data?.mimetype ?? '',
        filename: data?.filename || undefined,
        omitted: true,
        sizeBytes: (0, inbound_media_cap_1.coerceDeclaredSize)(data?.size),
    };
}
function isHttpUrl(value) {
    return /^https?:\/\//i.test(value);
}
async function loadRemoteMedia(url) {
    const { data, mimetype } = await (0, load_remote_media_1.loadRemoteMediaBuffer)(url);
    const filename = new URL(url).pathname.split('/').pop() || undefined;
    return new whatsapp_web_js_1.MessageMedia(mimetype || 'application/octet-stream', data.toString('base64'), filename);
}
function isNoLidForUserError(err) {
    return err instanceof Error && err.message.includes('No LID for user');
}
function isQuoteUnresolvedError(err) {
    return err instanceof Error && err.message.includes('Could not get the quoted message');
}
async function toMessageMedia(media, opts) {
    if (typeof media.data === 'string' && isHttpUrl(media.data)) {
        const fetched = await loadRemoteMedia(media.data);
        if (opts?.trustDeclaredType !== false && media.mimetype && media.mimetype !== 'application/octet-stream') {
            fetched.mimetype = media.mimetype;
        }
        const normalizeMediaType = (value) => (value ?? '').split(';', 1)[0].trim().toLowerCase();
        const fetchedType = normalizeMediaType(fetched.mimetype);
        const declaredType = normalizeMediaType(media.mimetype);
        const fetchedTypeIsGeneric = !fetchedType || fetchedType === 'application/octet-stream';
        const declaredTypeIsConvertible = declaredType.startsWith('image/') || declaredType.startsWith('video/');
        if (opts?.trustDeclaredType === false && fetchedTypeIsGeneric && declaredTypeIsConvertible) {
            fetched.mimetype = declaredType;
        }
        if (media.filename) {
            fetched.filename = media.filename;
        }
        return fetched;
    }
    const data = typeof media.data === 'string' ? media.data : media.data.toString('base64');
    return new whatsapp_web_js_1.MessageMedia(media.mimetype, data, media.filename);
}
function toMessageResult(msg) {
    if (!msg) {
        throw new Error('the engine returned no message for this send, so it may not have been delivered — check the chat before retrying');
    }
    const id = msg.id;
    return { id: id?._serialized ?? id?.$1 ?? '', timestamp: msg.timestamp };
}
class WwebjsMessaging {
    host;
    constructor(host) {
        this.host = host;
    }
    client() {
        return this.host.getClient();
    }
    withPage(context, op) {
        return (0, wwebjs_host_1.withPage)(this.host, context, op);
    }
    resolvedSendIds = new Map();
    async resolveSendId(chatId) {
        if (!chatId.endsWith('@c.us')) {
            return chatId;
        }
        const cached = this.resolvedSendIds.get(chatId);
        if (cached) {
            return cached;
        }
        try {
            const wid = await this.host.getNumberId(chatId);
            if (wid) {
                this.resolvedSendIds.set(chatId, wid);
                if (wid.endsWith('@lid')) {
                    void this.host.config.lidMappingStore
                        ?.remember((0, wa_id_1.userPart)(wid), (0, wa_id_1.userPart)(chatId), this.host.config.sessionId)
                        ?.catch(() => { });
                }
                return wid;
            }
            return chatId;
        }
        catch {
            return chatId;
        }
    }
    quoteOptions(quotedMessageId) {
        return quotedMessageId ? { quotedMessageId, ignoreQuoteErrors: false } : {};
    }
    async sendResolved(chatId, send, quotedMessageId) {
        const to = await this.resolveSendId(chatId);
        try {
            return await send(to);
        }
        catch (err) {
            this.host.reportIfPageTransportError(err, 'sendMessage');
            if (quotedMessageId && isQuoteUnresolvedError(err)) {
                throw new message_not_found_error_1.MessageNotFoundError(quotedMessageId);
            }
            if (!chatId.endsWith('@c.us') || !isNoLidForUserError(err)) {
                throw err;
            }
            this.resolvedSendIds.delete(chatId);
            const fresh = await this.resolveSendId(chatId);
            if (fresh === to) {
                throw new recipient_unreachable_error_1.RecipientUnreachableError(chatId);
            }
            this.host.logger.warn('Send retried against a re-resolved id after "No LID for user"; may duplicate', {
                chatId,
                staleId: to,
                freshId: fresh,
            });
            try {
                return await send(fresh);
            }
            catch (retryErr) {
                if (quotedMessageId && isQuoteUnresolvedError(retryErr)) {
                    throw new message_not_found_error_1.MessageNotFoundError(quotedMessageId);
                }
                if (isNoLidForUserError(retryErr)) {
                    throw new recipient_unreachable_error_1.RecipientUnreachableError(chatId);
                }
                throw retryErr;
            }
        }
    }
    async sendTextMessage(chatId, text, mentions, options) {
        this.host.ensureReady();
        if (options?.customPreview) {
            throw new engine_not_supported_error_1.EngineNotSupportedError('sendTextMessage(customPreview)');
        }
        const sendOptions = this.quoteOptions(options?.quotedMessageId);
        if (mentions?.length)
            sendOptions.mentions = mentions;
        if (options?.linkPreview === false)
            sendOptions.linkPreview = false;
        const msg = await this.sendResolved(chatId, to => Object.keys(sendOptions).length
            ? this.client().sendMessage(to, text, sendOptions)
            : this.client().sendMessage(to, text), options?.quotedMessageId);
        return toMessageResult(msg);
    }
    async sendImageMessage(chatId, media) {
        return this.sendMediaMessage(chatId, media);
    }
    async sendVideoMessage(chatId, media) {
        return this.sendMediaMessage(chatId, media);
    }
    async sendAudioMessage(chatId, media) {
        return this.sendMediaMessage(chatId, media, media.ptt ? { sendAudioAsVoice: true } : undefined);
    }
    async sendDocumentMessage(chatId, media) {
        const kind = (0, wa_id_1.chatKind)(chatId);
        const asDocument = kind !== 'status' && kind !== 'broadcast';
        return this.sendMediaMessage(chatId, media, asDocument ? { sendMediaAsDocument: true } : undefined);
    }
    async sendMediaMessage(chatId, media, extraOptions) {
        this.host.ensureReady();
        this.host.ensureNotChannelRecipient(chatId);
        const messageMedia = await toMessageMedia(media);
        if (extraOptions?.sendMediaAsDocument && !messageMedia.filename) {
            messageMedia.filename = 'file';
        }
        const msg = await this.sendResolved(chatId, to => this.client().sendMessage(to, messageMedia, {
            caption: media.caption,
            ...(media.mentions?.length ? { mentions: media.mentions } : {}),
            ...extraOptions,
            ...this.quoteOptions(media.quotedMessageId),
        }), media.quotedMessageId);
        return toMessageResult(msg);
    }
    async sendLocationMessage(chatId, location) {
        this.host.ensureReady();
        const module = await import('whatsapp-web.js');
        const Location = module.Location || module.default?.Location;
        const loc = new Location(location.latitude, location.longitude, {
            name: location.description || '',
            address: location.address || '',
        });
        const msg = await this.sendResolved(chatId, to => this.client().sendMessage(to, loc, this.quoteOptions(location.quotedMessageId)), location.quotedMessageId);
        return toMessageResult(msg);
    }
    async sendContactMessage(chatId, contact) {
        this.host.ensureReady();
        const vcard = (0, vcard_1.buildVCard)(contact);
        const msg = await this.sendResolved(chatId, to => this.client().sendMessage(to, vcard, {
            parseVCards: true,
            ...this.quoteOptions(contact.quotedMessageId),
        }), contact.quotedMessageId);
        return toMessageResult(msg);
    }
    async sendStickerMessage(chatId, media) {
        this.host.ensureReady();
        this.host.ensureNotChannelRecipient(chatId);
        const messageMedia = await toMessageMedia(media, { trustDeclaredType: false });
        const msg = await this.sendResolved(chatId, to => this.client().sendMessage(to, messageMedia, {
            sendMediaAsSticker: true,
            ...this.quoteOptions(media.quotedMessageId),
            ...(media.mentions?.length ? { mentions: media.mentions } : {}),
        }), media.quotedMessageId);
        return toMessageResult(msg);
    }
    async sendPollMessage(chatId, poll) {
        this.host.ensureReady();
        const module = await import('whatsapp-web.js');
        const Poll = module.Poll || module.default?.Poll;
        const pollOptions = { allowMultipleAnswers: poll.allowMultipleAnswers === true };
        const msg = await this.sendResolved(chatId, to => this.client().sendMessage(to, new Poll(poll.name, poll.options, pollOptions), this.quoteOptions(poll.quotedMessageId)), poll.quotedMessageId);
        return toMessageResult(msg);
    }
    async replyToMessage(chatId, quotedMsgId, text, mentions) {
        this.host.ensureReady();
        try {
            const chat = await this.client().getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 100 });
            const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);
            if (!quotedMsg) {
                throw new message_not_found_error_1.MessageNotFoundError(quotedMsgId);
            }
            const msg = await this.sendResolved(chatId, to => mentions?.length ? quotedMsg.reply(text, to, { mentions }) : quotedMsg.reply(text, to));
            return toMessageResult(msg);
        }
        catch (error) {
            this.host.reportIfPageTransportError(error, 'replyToMessage');
            throw error;
        }
    }
    async forwardMessage(fromChatId, toChatId, messageId) {
        this.host.ensureReady();
        try {
            const chat = await this.client().getChatById(fromChatId);
            const messages = await chat.fetchMessages({ limit: 100 });
            const msgToForward = messages.find(m => m.id._serialized === messageId);
            if (!msgToForward) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId);
            }
            let resolvedTo = toChatId;
            await this.sendResolved(toChatId, to => {
                resolvedTo = to;
                return msgToForward.forward(to);
            });
            try {
                const destChat = await this.client().getChatById(resolvedTo);
                const sentByMe = (await destChat?.fetchMessages({ limit: 5, fromMe: true })) ?? [];
                let sent;
                for (const m of sentByMe) {
                    if (!sent || m.timestamp > sent.timestamp) {
                        sent = m;
                    }
                }
                if (sent) {
                    return toMessageResult(sent);
                }
            }
            catch (error) {
                this.host.reportIfPageTransportError(error, 'forwardMessage');
                this.host.logger.warn(`Forward succeeded but recovering the sent message id failed: ${String(error)}`);
            }
            return { id: '', timestamp: Math.floor(Date.now() / 1000) };
        }
        catch (error) {
            this.host.reportIfPageTransportError(error, 'forwardMessage');
            throw error;
        }
    }
    async reactToMessage(chatId, messageId, emoji) {
        this.host.ensureReady();
        await this.withPage('reactToMessage', async () => {
            const chat = await this.client().getChatById(chatId);
            if (!chat) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            const messages = await chat.fetchMessages({ limit: 100 });
            const message = messages.find(m => m.id._serialized === messageId);
            if (!message) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            await message.react(emoji);
        });
        this.host.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
    }
    async getMessageReactions(chatId, messageId) {
        this.host.ensureReady();
        const reactions = await this.withPage('getMessageReactions', async () => {
            const chat = await this.client().getChatById(chatId);
            if (!chat) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            const messages = await chat.fetchMessages({ limit: 100 });
            const message = messages.find(m => m.id._serialized === messageId);
            if (!message) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            const msgWithReactions = message;
            return msgWithReactions.hasReaction ? msgWithReactions.getReactions() : [];
        });
        if (!reactions) {
            return [];
        }
        const result = [];
        for (const r of reactions) {
            result.push({
                emoji: String(r.id),
                senders: (r.senders || []).map(s => ({
                    senderId: String(s.senderId),
                    emoji: String(s.reaction),
                    timestamp: Number(s.timestamp),
                })),
            });
        }
        return result;
    }
    async getChatHistory(chatId, limit = 50, includeMedia = false, mediaMaxBytes, signal) {
        this.host.ensureReady();
        const messages = await this.withPage('getChatHistory', async () => {
            const chat = await this.client().getChatById(chatId);
            if (!chat) {
                return [];
            }
            return chat.fetchMessages({ limit });
        });
        const results = [];
        let mediaBudget = !includeMedia
            ? Number.POSITIVE_INFINITY
            : mediaMaxBytes === undefined
                ? (0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)()
                : (0, inbound_media_cap_1.ingestMediaBudgetBytes)(mediaMaxBytes);
        for (const msg of messages) {
            if (signal?.aborted) {
                break;
            }
            const out = (0, message_mapper_1.buildIncomingMessageBase)(msg);
            out.chatId = chatId;
            out.isGroup = chatId.endsWith('@g.us');
            out.isStatusBroadcast = chatId === 'status@broadcast';
            out.kind = (0, wa_id_1.chatKind)(chatId);
            const call = extractWwebjsCall(msg);
            if (call)
                out.call = call;
            if (msg.type === whatsapp_web_js_1.MessageTypes.LOCATION && msg.location) {
                out.location = {
                    latitude: Number(msg.location.latitude),
                    longitude: Number(msg.location.longitude),
                    description: msg.location.description || undefined,
                    address: msg.location.address || undefined,
                    url: msg.location.url || undefined,
                };
            }
            if (msg.hasQuotedMsg) {
                try {
                    const quoted = await msg.getQuotedMessage();
                    out.quotedMessage = { id: quoted.id._serialized, body: quoted.body };
                }
                catch (error) {
                    this.host.logger.warn(`Failed to resolve quoted message for ${msg.id._serialized}: ${String(error)}`);
                }
            }
            if (includeMedia && msg.hasMedia) {
                if (mediaBudget <= 0) {
                    out.media = declaredOnlyMedia(msg);
                }
                else {
                    try {
                        const capped = await this.host.capInboundMediaFor(msg, mediaMaxBytes);
                        if (capped) {
                            out.media = capped;
                            if (capped.data) {
                                mediaBudget -= capped.data.length;
                            }
                        }
                    }
                    catch (error) {
                        this.host.logger.warn(`Failed to download media for ${msg.id._serialized}: ${String(error)}`);
                    }
                }
            }
            results.push(out);
        }
        return results;
    }
    async deleteMessage(chatId, messageId, forEveryone = true) {
        this.host.ensureReady();
        await this.withPage('deleteMessage', async () => {
            const chat = await this.client().getChatById(chatId);
            if (!chat) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            const messages = await chat.fetchMessages({ limit: 100 });
            const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
            if (!message) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            await message.delete(forEveryone);
        });
        this.host.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
    }
    async editMessage(chatId, messageId, body, mentions) {
        this.host.ensureReady();
        const edited = await this.withPage('editMessage', async () => {
            const chat = await this.client().getChatById(chatId);
            if (!chat) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            const messages = await chat.fetchMessages({ limit: 100 });
            const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
            if (!message) {
                throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
            }
            return mentions?.length ? message.edit(body, { mentions }) : message.edit(body);
        });
        if (!edited) {
            throw new engine_refused_error_1.EngineRefusedError(`the edit of message ${messageId} was rejected — only the account's own text messages can be edited`);
        }
        this.host.logger.log(`Edited message ${messageId} in chat ${chatId}`);
        return toMessageResult(edited);
    }
    async findInFetchWindow(chatId, messageId) {
        const chat = await this.client().getChatById(chatId);
        if (!chat)
            throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
        const messages = await chat.fetchMessages({ limit: 100 });
        const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
        if (!message)
            throw new message_not_found_error_1.MessageNotFoundError(messageId, chatId);
        return message;
    }
    async votePoll(chatId, pollMessageId, options) {
        this.host.ensureReady();
        try {
            await this.withPage('votePoll', async () => {
                const message = await this.findInFetchWindow(chatId, pollMessageId);
                await message.vote(options);
            });
        }
        catch (error) {
            if (typeof error === 'string') {
                throw new common_1.BadRequestException(`Message ${pollMessageId} is not a poll: ${error}`);
            }
            throw error;
        }
        this.host.logger.log(`Voted on poll ${pollMessageId} in chat ${chatId} (${options.length} option(s))`);
    }
    async pinMessage(chatId, messageId, durationSeconds) {
        this.host.ensureReady();
        const pinned = await this.withPage('pinMessage', async () => {
            const message = await this.findInFetchWindow(chatId, messageId);
            return message.pin(durationSeconds);
        });
        if (!pinned) {
            throw new engine_refused_error_1.EngineRefusedError(`the pin of message ${messageId} was rejected — in a group only admins may pin, and the duration must be 24h, 7d or 30d`);
        }
        this.host.logger.log(`Pinned message ${messageId} in chat ${chatId} for ${durationSeconds}s`);
    }
    async starMessage(chatId, messageId, star) {
        this.host.ensureReady();
        await this.withPage('starMessage', async () => {
            const message = await this.findInFetchWindow(chatId, messageId);
            await (star ? message.star() : message.unstar());
        });
        this.host.logger.log(`${star ? 'Starred' : 'Unstarred'} message ${messageId} in chat ${chatId}`);
    }
    async unpinMessage(chatId, messageId) {
        this.host.ensureReady();
        const unpinned = await this.withPage('unpinMessage', async () => {
            const message = await this.findInFetchWindow(chatId, messageId);
            return message.unpin();
        });
        if (!unpinned) {
            throw new engine_refused_error_1.EngineRefusedError(`the unpin of message ${messageId} was rejected — in a group only admins may unpin`);
        }
        this.host.logger.log(`Unpinned message ${messageId} in chat ${chatId}`);
    }
}
exports.WwebjsMessaging = WwebjsMessaging;
//# sourceMappingURL=wwebjs-messaging.js.map