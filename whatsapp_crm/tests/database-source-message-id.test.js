'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');

describe('Database provider message identity', () => {
    it('deduplicates within business, chat and channel without overwriting the acknowledged message', async () => {
        const database = createTestDB();
        try {
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            const chatId = '79990000001@c.us';
            await DB.getOrCreateClient(first.id, chatId, 'Guest');
            await DB.getOrCreateClient(second.id, chatId, 'Guest');

            const saved = await DB.saveMessageWithChannel(first.id, chatId, 'Guest', 'Original',
                'user', 'whatsapp', null, 'provider-1');
            const replay = await DB.saveMessageWithChannel(first.id, chatId, 'Guest', 'Changed replay',
                'user', 'whatsapp', null, 'provider-1');
            const otherChannel = await DB.saveMessageWithChannel(first.id, chatId, 'Guest', 'Telegram',
                'user', 'telegram', null, 'provider-1');
            const otherBusiness = await DB.saveMessageWithChannel(second.id, chatId, 'Guest', 'Other tenant',
                'user', 'whatsapp', null, 'provider-1');

            assert.equal(saved.inserted, true);
            assert.deepEqual(replay, { inserted: false });
            assert.equal(otherChannel.inserted, true);
            assert.equal(otherBusiness.inserted, true);
            assert.deepEqual(DB.all('SELECT instanceId,channel,content FROM messages ORDER BY id')
                .map(row => [row.instanceId, row.channel, row.content]), [
                [first.id, 'whatsapp', 'Original'],
                [first.id, 'telegram', 'Telegram'],
                [second.id, 'whatsapp', 'Other tenant'],
            ]);
            assert.equal(DB.get('SELECT lastMessage FROM clients WHERE instanceId=? AND chatId=?',
                [first.id, chatId]).lastMessage, 'Telegram');
        } finally { database.close(); }
    });
});
