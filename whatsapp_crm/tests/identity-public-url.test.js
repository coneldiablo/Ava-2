'use strict';

const { describe, it, assert } = require('./test-helper');
const { getPublicUrl } = require('../src/services/identity/public-url');
const Auth = require('../src/services/auth.service');

describe('Identity public URL configuration', () => {
    it('rejects missing, malformed, credentialed and non-HTTPS production origins at startup', () => {
        const originalUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const originalEnv = process.env.NODE_ENV;
        const originalAccess = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        try {
            process.env.NODE_ENV = 'production';
            process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
            for (const value of [undefined, '', 'not-a-url', 'http://localhost:3000',
                'https://user:password@example.test', 'https://example.test/path',
                'https://example.test/?token=secret']) {
                if (value === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
                else process.env.WHATSAPP_CRM_PUBLIC_URL = value;
                assert.throws(() => Auth.assertConfigured(), { code: 'PUBLIC_URL_INVALID', statusCode: 503 });
            }
            process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
            assert.strictEqual(getPublicUrl().origin, 'https://ava.example.test');
        } finally {
            if (originalUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = originalUrl;
            if (originalEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalEnv;
            if (originalAccess === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = originalAccess;
        }
    });

    it('allows local HTTP only in explicit test or development environments', () => {
        const originalUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const originalEnv = process.env.NODE_ENV;
        try {
            process.env.WHATSAPP_CRM_PUBLIC_URL = 'http://localhost:3000';
            for (const environment of ['test', 'development']) {
                process.env.NODE_ENV = environment;
                assert.strictEqual(getPublicUrl().origin, 'http://localhost:3000');
            }
            process.env.WHATSAPP_CRM_PUBLIC_URL = 'http://staging.example.test';
            assert.throws(() => getPublicUrl(), { code: 'PUBLIC_URL_INVALID' });
        } finally {
            if (originalUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = originalUrl;
            if (originalEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalEnv;
        }
    });
});
