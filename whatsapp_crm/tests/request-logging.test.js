const { describe, it, assert } = require('./test-helper');
const Logger = require('../src/utils/logger');

describe('Safe HTTP request logging', () => {
    it('never logs opaque Bnovo or Twenty webhook credentials', () => {
        for (const provider of ['bnovo', 'twenty']) {
            assert.strictEqual(
                Logger.safeRequestPath(`/api/integrations/${provider}/webhooks/opaque-secret?api_key=query-secret`),
                `/api/integrations/${provider}/webhooks/[REDACTED]`,
            );
        }
        assert.strictEqual(
            Logger.safeRequestPath('/API/integrations/twenty/webhooks%2Fopaque%2Dsecret/extra'),
            '/API/integrations/twenty/webhooks/[REDACTED]',
        );
    });

    it('drops query strings and fragments, strips control characters, and caps output', () => {
        assert.strictEqual(Logger.safeRequestPath('/api/hotels?token=secret&password=secret#secret'), '/api/hotels');
        assert.strictEqual(Logger.safeRequestPath('/api/hello%0d%0aworld'), '/api/helloworld');
        assert.strictEqual(Logger.safeRequestPath('/api/%zz/secret'), '[invalid-request-path]');
        assert.strictEqual(Logger.safeRequestPath('/' + 'a'.repeat(1000)).length, 512);
    });
});
