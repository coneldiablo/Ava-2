const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const HotelProfileService = require('../src/services/hotel-profile.service');
const SalesBrain = require('../src/services/sales-brain.service');
const AIService = require('../src/services/ai.service');
const VoiceOptions = require('../src/services/voice-options.service');
const configured = fn => async () => {
    const original = VoiceOptions.getOptions;
    VoiceOptions.getOptions = async () => ({ providers: ['google_live', 'openai_realtime', 'yandex_realtime'].map(id => {
        const value = VoiceOptions.getDefaults(id);
        return { id, available: true, models: [{ id: value.model }], voices: [{ id: value.voiceName }] };
    }) });
    try { await fn(); } finally { VoiceOptions.getOptions = original; }
};

describe('Hotel Profile Tests', () => {
    it('should expose legacy standard businesses to AVA without creating a duplicate', async () => {
        createTestDB();

        const legacy = await DB.createInstance({
            name: 'Legacy Hotel',
            businessType: 'standard',
            salesGoal: 'call'
        });

        const listed = await HotelProfileService.list();
        const loaded = await HotelProfileService.get(legacy.id);

        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0].business_id, legacy.id);
        assert.strictEqual(loaded.business_id, legacy.id);
        assert.strictEqual(loaded.businessType, 'standard');

        const upgraded = await HotelProfileService.update(legacy.id, {
            name: 'Legacy Hotel',
            hotelTimezone: 'Europe/Moscow'
        });
        const raw = await DB.getInstance(legacy.id);

        assert.strictEqual(upgraded.business_id, legacy.id);
        assert.strictEqual(raw.businessType, 'hotel');
        assert.strictEqual((await HotelProfileService.list()).length, 1);
    });

    it('should create and update hotel profile without losing instance secrets', configured(async () => {
        createTestDB();

        const profile = await HotelProfileService.create({
            name: 'Hotel One',
            hotelTone: 'friendly and concise',
            hotelTimezone: 'Europe/Moscow',
            sipAliases: ['+7 (495) 123-45-67'],
            sipTrunkNumber: 'mts-hotel-one',
            voiceContextName: 'unified_sales_agent',
            aiProvider: 'google_live',
            voiceName: 'Aoede'
        });
        await DB.updateInstance(profile.id, { greenApiToken: 'green-secret-token' });

        const updated = await HotelProfileService.update(profile.id, {
            name: 'Hotel One Prime',
            sipAliases: ['74951234567', '1001'],
            hotelWorkingHours: {
                mon: { enabled: true, start: '08:00', end: '22:00' }
            }
        });
        const raw = await DB.getInstance(profile.id);

        assert.strictEqual(updated.business_id, profile.id);
        assert.strictEqual(updated.instance_id, profile.id);
        assert.strictEqual(updated.name, 'Hotel One Prime');
        assert.deepStrictEqual(updated.sipAliases, ['74951234567', '1001']);
        assert.strictEqual(updated.hotelWorkingHours.mon.start, '08:00');
        assert.strictEqual(updated.aiProvider, 'google_live');
        assert.strictEqual(updated.ai_provider, 'google_live');
        assert.strictEqual(updated.voiceName, 'Aoede');
        assert.strictEqual(updated.voice, 'Aoede');
        assert.strictEqual(raw.aiProvider, 'yandex');
        assert.strictEqual(raw.voiceAiProvider, 'google_live');
        assert.strictEqual(raw.voiceName, 'Aoede');
        assert.strictEqual(raw.greenApiToken, 'green-secret-token');
    }));

    it('should keep CRM and voice AI providers independent', configured(async () => {
        createTestDB();

        const instance = await DB.createInstance({
            name: 'Provider Split Hotel',
            businessType: 'hotel',
            salesGoal: 'call'
        });
        await DB.updateInstance(instance.id, { aiProvider: 'yandex' });

        const updated = await HotelProfileService.update(instance.id, {
            aiProvider: 'google_live',
            voiceName: 'Aoede'
        });
        const raw = await DB.getInstance(instance.id);

        assert.strictEqual(updated.aiProvider, 'google_live');
        assert.strictEqual(updated.crmAiProvider, 'yandex');
        assert.strictEqual(raw.aiProvider, 'yandex');
        assert.strictEqual(raw.voiceAiProvider, 'google_live');
    }));

    it('keeps text-assistant instructions scoped to the selected business and bounds their size', async () => {
        createTestDB();
        const first = await DB.createInstance({ name: 'First Hotel', businessType: 'hotel' });
        const second = await DB.createInstance({ name: 'Second Hotel', businessType: 'hotel' });
        await HotelProfileService.update(first.id, { systemPrompt: 'Используй только факты первого отеля.' });
        assert.strictEqual((await HotelProfileService.get(first.id)).systemPrompt, 'Используй только факты первого отеля.');
        assert.strictEqual((await HotelProfileService.get(second.id)).systemPrompt, '');
        await assert.rejects(() => HotelProfileService.update(first.id, { systemPrompt: 'x'.repeat(8001) }), /up to 8000/);
        assert.strictEqual((await HotelProfileService.get(first.id)).systemPrompt, 'Используй только факты первого отеля.');
    });

    it('durably switches voice providers without losing tenant prompts or changing chat AI', configured(async () => {
        createTestDB();
        const a = await DB.createInstance({ name: 'A', businessType: 'hotel' });
        const b = await DB.createInstance({ name: 'B', businessType: 'hotel' });
        await HotelProfileService.update(a.id, { systemPrompt: 'Only A instructions', voiceAiProvider: 'yandex_realtime' });
        await HotelProfileService.update(b.id, { systemPrompt: 'Only B instructions', voiceAiProvider: 'openai_realtime' });
        for (const provider of ['yandex_realtime', 'google_live', 'openai_realtime', '']) {
            await HotelProfileService.update(a.id, { voiceAiProvider: provider });
            const stored = await HotelProfileService.get(a.id);
            assert.strictEqual(stored.voiceAiProvider, provider || VoiceOptions.getDefaultProvider());
            assert.strictEqual(stored.ai_provider, provider || VoiceOptions.getDefaultProvider());
            assert.strictEqual(stored.systemPrompt, 'Only A instructions');
            assert.strictEqual(stored.business_id, a.id);
            assert.strictEqual((await DB.getInstance(a.id)).aiProvider, 'yandex');
            assert.strictEqual((await HotelProfileService.get(b.id)).systemPrompt, 'Only B instructions');
            assert.strictEqual((await HotelProfileService.get(b.id)).voiceAiProvider, 'openai_realtime');
        }
    }));

    it('rejects invalid voice providers on profile, generic instance writes and creation', async () => {
        createTestDB();
        const a = await DB.createInstance({ name: 'A', businessType: 'hotel' });
        for (const value of ['yandex', 'unsupported', {}, 123]) {
            await assert.rejects(() => HotelProfileService.update(a.id, { voiceAiProvider: value }), /Unsupported voice/);
            await assert.rejects(() => DB.updateInstance(a.id, { voiceAiProvider: value }), /Unsupported voice/);
            await assert.rejects(() => HotelProfileService.create({ name: 'Invalid', voiceAiProvider: value }), /Unsupported voice/);
        }
        assert.strictEqual((await HotelProfileService.list()).length, 1);
    });

    it('only permits the owner to change voice provider in the same business', () => {
        createTestDB();
        const Identity = require('../src/services/identity/identity-store');
        const Access = require('../src/services/identity/customer-access');
        Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A'),(2,'B')");
        const original = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        try {
            for (const role of ['hotel_owner', 'manager']) {
                const invite = Identity.createInvitation({ platformRole: 'platform_admin' }, { email: `${role}@example.test`, businessId: 1, role });
                const auth = Identity.completeInvitation(Identity.claimInvitation(invite.token), `${role}-voice-test`);
                function write(id, body) {
                    let passed = false, status = 200;
                    const req = { auth, params: { id: String(id) }, body, headers: { origin: 'https://ava.example.test' }, query: {} };
                    Access.forRoute('put', '/hotel-profiles/:id')(req, { status(code) { status = code; return this; }, json() {} }, () => { passed = true; });
                    return { passed, status, body: req.body };
                }
                const result = write(1, { voiceAiProvider: 'yandex_realtime' });
                assert.strictEqual(result.passed, role === 'hotel_owner');
                if (role === 'hotel_owner') assert.deepStrictEqual(result.body, { voiceAiProvider: 'yandex_realtime' });
                else assert.strictEqual(result.status, 403);
                assert.strictEqual(write(2, { voiceAiProvider: 'yandex_realtime' }).status, 403);
                assert.strictEqual(write(1, { voiceAiProvider: 'yandex_realtime', businessId: 2 }).status, 403);
            }
        } finally {
            if (original === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = original;
        }
    });

    it('should reject duplicate active SIP aliases across hotels', async () => {
        createTestDB();

        await HotelProfileService.create({
            name: 'Hotel A',
            hotelTimezone: 'UTC',
            sipAliases: ['1001']
        });
        await assert.rejects(
            () => HotelProfileService.create({
                name: 'Hotel B',
                hotelTimezone: 'UTC',
                sipAliases: ['+1 001']
            }),
            /already belongs/
        );
    });

    it('loads and updates coffee assistant settings without converting the business or adding it to the hotel registry', async () => {
        createTestDB();

        const coffee = await DB.createInstance({
            name: 'Coffee Only',
            businessType: 'coffee_shop',
            salesGoal: 'coffee_pickup'
        });

        assert.strictEqual((await HotelProfileService.get(coffee.id)).businessType, 'coffee_shop');
        assert.strictEqual((await HotelProfileService.list()).length, 0);
        const updated = await HotelProfileService.update(coffee.id, { systemPrompt: 'Help with coffee pickup.', hotelTone: 'Friendly', hotelTimezone: 'Europe/Moscow' });
        assert.strictEqual(updated.systemPrompt, 'Help with coffee pickup.');
        assert.strictEqual(updated.hotelTone, 'Friendly');
        assert.strictEqual(updated.hotelTimezone, 'Europe/Moscow');
        assert.strictEqual((await DB.getInstance(coffee.id)).businessType, 'coffee_shop');
        assert.strictEqual((await DB.getInstance(coffee.id)).salesGoal, 'coffee_pickup');
    });

    it('should pass hotel name and tone to outbound opening prompt', async () => {
        createTestDB();
        const profile = await HotelProfileService.create({
            name: 'Grand Pilot Hotel',
            hotelTone: 'warm premium hotel concierge',
            hotelTimezone: 'Europe/Moscow',
        });

        const originalGeneratePlainText = AIService.generatePlainText;
        let seenPayload = '';
        AIService.generatePlainText = async (messages) => {
            seenPayload = messages.map((message) => message.content).join('\n');
            return '';
        };

        try {
            const result = await SalesBrain.generateOutboundOpening({
                instanceId: profile.id,
                phone: '79990000012',
                direction: 'outbound',
                businessName: profile.name,
                hotelTone: profile.hotelTone,
                timezone: profile.hotelTimezone
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fallback_used, true);
            assert.ok(result.opening.includes('Grand Pilot Hotel'));
            assert.ok(seenPayload.includes('Grand Pilot Hotel'));
            assert.ok(seenPayload.includes('warm premium hotel concierge'));
            assert.ok(seenPayload.includes('Europe/Moscow'));
        } finally {
            AIService.generatePlainText = originalGeneratePlainText;
        }
    });
});
