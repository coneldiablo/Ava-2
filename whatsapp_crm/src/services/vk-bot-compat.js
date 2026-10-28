const { VK } = require('vk-io');

class VkBotCompat {
    constructor({ token, group_id: groupId }) {
        this.groupId = groupId || null;
        this.vk = new VK({ token });
        this._pollPromise = null;
    }

    on(handler) {
        this.vk.updates.on('message_new', async (context) => {
            await handler({
                message: {
                    from_id: context.senderId,
                    peer_id: context.peerId,
                    text: context.text || '',
                },
            });
        });
    }

    startPolling(onError) {
        if (this._pollPromise) return;
        this._pollPromise = this.vk.updates.startPolling()
            .catch((error) => onError?.(error))
            .finally(() => {
                this._pollPromise = null;
            });
    }

    stop() {
        this.vk.updates.stop();
    }

    sendMessage(peerId, text) {
        return this.vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: 0,
            message: text,
        });
    }

    async getGroupInfo() {
        const response = await this.vk.api.groups.getById(this.groupId ? { group_id: this.groupId } : {});
        const groups = response?.groups || response?.response || response;
        return Array.isArray(groups) ? groups[0] : null;
    }

    async getUserInfo(userId) {
        const response = await this.vk.api.users.get({ user_ids: String(userId) });
        const users = response?.response || response;
        return Array.isArray(users) ? users[0] : null;
    }
}

module.exports = VkBotCompat;
