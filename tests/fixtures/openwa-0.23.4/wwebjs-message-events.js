"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWwebjsMessageEvents = registerWwebjsMessageEvents;
const whatsapp_web_js_1 = require("whatsapp-web.js");
const message_mapper_1 = require("./message-mapper");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
function registerWwebjsMessageEvents(client, host) {
    client.on('message', async (msg) => {
        try {
            const incomingMessage = (0, message_mapper_1.buildIncomingMessageBase)(msg);
            try {
                const contact = await msg.getContact();
                if (contact) {
                    const full = process.env.WEBHOOK_CONTACT_DETAILS === 'true';
                    const merged = { ...incomingMessage.contact, ...(0, message_mapper_1.mapContactFields)(contact, full) };
                    if (Object.keys(merged).length > 0) {
                        incomingMessage.contact = merged;
                    }
                }
            }
            catch (error) {
                host.logger.error('Error getting message contact', String(error));
            }
            if (msg.type === whatsapp_web_js_1.MessageTypes.LOCATION && msg.location) {
                incomingMessage.location = {
                    latitude: Number(msg.location.latitude),
                    longitude: Number(msg.location.longitude),
                    description: msg.location.description || undefined,
                    address: msg.location.address || undefined,
                    url: msg.location.url || undefined,
                };
            }
            if (msg.hasMedia) {
                try {
                    const capped = await host.capInboundMediaFor(msg);
                    if (capped)
                        incomingMessage.media = capped;
                }
                catch (error) {
                    host.logger.error('Error downloading media', String(error));
                }
            }
            if (msg.hasQuotedMsg) {
                try {
                    const quoted = await msg.getQuotedMessage();
                    incomingMessage.quotedMessage = {
                        id: quoted.id._serialized,
                        body: quoted.body,
                    };
                }
                catch (error) {
                    host.logger.error('Error getting quoted message', String(error));
                }
            }
            const call = (0, wwebjs_messaging_1.extractWwebjsCall)(msg);
            if (call)
                incomingMessage.call = call;
            host.getCallbacks().onMessage?.(incomingMessage);
        }
        catch (error) {
            host.logger.error('Error processing incoming message', String(error));
        }
    });
    client.on('message_create', msg => {
        if (!msg.fromMe) {
            return;
        }
        void (async () => {
            const incomingMessage = (0, message_mapper_1.buildIncomingMessageBase)(msg);
            if (msg.hasMedia) {
                try {
                    incomingMessage.media = await host.capInboundMediaFor(msg);
                }
                catch (error) {
                    host.logger.warn('Own-send media download failed; emitting echo without media', {
                        msgId: msg.id?._serialized,
                        error: String(error),
                    });
                }
            }
            try {
                host.getCallbacks().onMessageCreate?.(incomingMessage);
            }
            catch (error) {
                host.logger.error('Error processing outgoing message', String(error));
            }
        })();
    });
    client.on('message_ack', (msg, ack) => {
        const rawId = msg.id;
        const ackId = rawId?._serialized ?? rawId?.$1;
        if (!ackId) {
            host.logger.warn('Dropping an ack whose message id could not be read', { ack });
            return;
        }
        host.getCallbacks().onMessageAck?.(ackId, (0, wwebjs_messaging_1.wwebjsAckToDeliveryStatus)(ack));
    });
    client.on('message_revoke_everyone', (after, before) => {
        try {
            const selfWid = host.getSelfWid();
            const afterId = after.id;
            const beforeId = before?.id;
            const payload = {
                id: afterId?._serialized ?? afterId?.$1 ?? '',
                revokedId: beforeId?._serialized ?? beforeId?.$1,
                chatId: after.from === selfWid ? after.to : after.from,
                from: after.from,
                to: after.to,
                type: 'revoked',
                body: '',
                timestamp: after.timestamp,
            };
            host.getCallbacks().onMessageRevoked?.(payload);
        }
        catch (error) {
            host.logger.error('Error processing message_revoke_everyone', String(error));
        }
    });
    client.on('message_reaction', reaction => {
        try {
            const msgId = reaction.msgId;
            const event = {
                messageId: msgId?._serialized ?? msgId?.$1 ?? '',
                chatId: reaction.id.remote,
                reaction: reaction.reaction,
                senderId: reaction.senderId,
            };
            host.getCallbacks().onMessageReaction?.(event);
        }
        catch (error) {
            host.logger.error('Error processing message_reaction', String(error));
        }
    });
    client.on('message_edit', (message, newBody) => {
        try {
            const editTimestamp = Math.floor(Date.now() / 1000);
            const base = (0, message_mapper_1.buildIncomingMessageBase)({
                id: message.id,
                from: message.from,
                to: message.to,
                body: String(newBody),
                type: message.type,
                timestamp: editTimestamp,
                fromMe: message.fromMe,
                author: message.author,
                mentionedIds: message.mentionedIds,
            });
            const payload = (0, message_mapper_1.buildEditedMessage)(base, Boolean(message.hasMedia));
            host.getCallbacks().onMessageEdited?.(payload);
        }
        catch (error) {
            host.logger.error('Error processing message_edit', String(error));
        }
    });
}
//# sourceMappingURL=wwebjs-message-events.js.map