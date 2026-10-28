const crypto = require('crypto');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Credentials = require('../src/services/channel-credentials');

async function withKey(value, test) {
    const previous = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
    if (value == null) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
    else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = value;
    try { await test(); } finally {
        if (previous === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previous;
    }
}

describe('Channel credential encryption', () => {
    it('encrypts each supported secret in storage and decrypts all instance read paths', async () => {
        await withKey(crypto.randomBytes(32).toString('hex'), async () => {
            createTestDB();
            const instance = await DB.createInstance({ name: 'Encrypted connectors' });
            const fields = Object.fromEntries(Credentials.SECRET_FIELDS.map(field => [field, `secret-${field}`]));
            await DB.updateInstance(instance.id, { ...fields, greenApiInstance: 'green-test', openWaSessionId: 'wa-test' });
            const raw = DB.get('SELECT * FROM instances WHERE id = ?', [instance.id]);
            for (const field of Credentials.SECRET_FIELDS) {
                assert.notStrictEqual(raw[field], fields[field]);
                assert.ok(raw[field].startsWith('enc:v1:'));
            }
            const decrypted = await DB.getInstance(instance.id);
            assert.deepStrictEqual(Credentials.SECRET_FIELDS.map(field => decrypted[field]),
                Credentials.SECRET_FIELDS.map(field => fields[field]));
            assert.strictEqual((await DB.getInstances())[0].telegramBotToken, fields.telegramBotToken);
            assert.strictEqual((await DB.getInstanceByGreenApi('green-test')).vkGroupToken, fields.vkGroupToken);
            assert.strictEqual((await DB.getInstanceByOpenWaSession('wa-test')).maxBotToken, fields.maxBotToken);
            assert.strictEqual((await DB.getInstanceByTelegramToken(fields.telegramBotToken)).id, instance.id);
            assert.strictEqual(await DB.getInstanceByTelegramToken('wrong'), null);
        });
    });

    it('fails closed on a missing or incorrect key and binds ciphertext to business and field', async () => {
        const key = crypto.randomBytes(32).toString('base64');
        await withKey(key, async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            await DB.updateInstance(first.id, { telegramBotToken: 'sensitive' });
            const raw = DB.get('SELECT telegramBotToken FROM instances WHERE id = ?', [first.id]).telegramBotToken;
            assert.throws(() => Credentials.decrypt(raw, second.id, 'telegramBotToken'), /decryption failed/);
            assert.throws(() => Credentials.decrypt(raw, first.id, 'vkGroupToken'), /decryption failed/);
            await withKey(null, async () => {
                await assert.rejects(DB.getInstance(first.id), /MASTER_KEY is required/);
                await assert.rejects(DB.updateInstance(second.id, { maxBotToken: 'new-secret' }), /MASTER_KEY is required/);
            });
            await withKey(crypto.randomBytes(32).toString('hex'), async () => {
                await assert.rejects(DB.getInstance(first.id), /decryption failed/);
            });
            assert.strictEqual(DB.get('SELECT maxBotToken FROM instances WHERE id = ?', [second.id]).maxBotToken, null);
        });
    });

    it('reads legacy plaintext and migrates all legacy credentials on the next write with a key', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Legacy credentials' });
        DB.run('UPDATE instances SET telegramBotToken = ?, emailSmtpPass = ? WHERE id = ?',
            ['legacy-telegram', 'legacy-smtp', instance.id]);
        await withKey(null, async () => {
            assert.strictEqual((await DB.getInstance(instance.id)).telegramBotToken, 'legacy-telegram');
            await assert.rejects(DB.updateInstance(instance.id, { vkGroupToken: 'new-secret' }), /MASTER_KEY is required/);
            assert.strictEqual(DB.get('SELECT vkGroupToken FROM instances WHERE id = ?', [instance.id]).vkGroupToken, null);
        });
        await withKey(crypto.randomBytes(32).toString('hex'), async () => {
            await DB.updateInstance(instance.id, { name: 'Migrated' });
            const raw = DB.get('SELECT * FROM instances WHERE id = ?', [instance.id]);
            assert.ok(raw.telegramBotToken.startsWith('enc:v1:'));
            assert.ok(raw.emailSmtpPass.startsWith('enc:v1:'));
            assert.strictEqual((await DB.getInstance(instance.id)).emailSmtpPass, 'legacy-smtp');
        });
    });
});
