'use strict';
// Run inside the installed CRM. No business writes, credentials or transcripts.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const appRequire = createRequire('/app/package.json');
async function main() {
    const options = appRequire('./src/services/voice-options.service');
    const catalog = await options.getOptions();
    const neuro = catalog.providers.find(value => value.id === 'neuro_gemini');
    assert.equal(neuro.available, true);
    assert.deepEqual(neuro.models.map(value => value.id), ['gemini-3.8-flash', 'gemini-3.7-flash']);
    assert.ok(neuro.voices.length >= 2);
    assert.ok(neuro.voices.some(value => value.id === 'edsel'));
    const result = await options.preview({ provider: 'neuro_gemini', voiceName: 'edsel' });
    assert.equal(result.contentType, 'audio/wav');
    assert.equal(result.audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.audio.toString('ascii', 8, 12), 'WAVE');
    assert.equal(result.audio.readUInt32LE(4), result.audio.length - 8);
    assert.equal(result.audio.readUInt32LE(40), result.audio.length - 44);
    assert.ok(result.audio.length > 44 && result.audio.length <= 192044);
    const token = process.env.CRM_SERVICE_API_TOKEN || process.env.SALES_BRAIN_API_TOKEN || process.env.WHATSAPP_CRM_API_TOKEN;
    assert.ok(token);
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/ml/hotel-profiles/1`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.success, true);
    const profile = value.profile;
    assert.equal(Number(profile.id), 1);
    assert.equal(typeof profile.voiceAiProvider, 'string');
    assert.equal(typeof profile.voiceModel, 'string');
    assert.equal(typeof profile.voiceName, 'string');
    assert.equal(typeof profile.voiceSettings, 'object');
    console.log(JSON.stringify({ pass: true, installedCatalog: true,
        models: neuro.models.map(value => value.id), voiceCount: neuro.voices.length,
        previewBytes: result.audio.length, previewFiniteWav: true,
        serviceProfileCanonicalFields: true, businessWrites: 0,
        authenticatedBrowserTested: false, carrierCallTested: false }));
}
main().catch(() => { console.log(JSON.stringify({ pass: false, code: 'INSTALLED_CATALOG_OR_PROFILE_FAILED' })); process.exitCode = 1; });
