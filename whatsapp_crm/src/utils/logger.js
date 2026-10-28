class Logger {
    static safeRequestPath(originalUrl) {
        // Query values and opaque webhook path tokens are credentials, not logs.
        // Decode before matching so equivalent percent-encoded routes are safe too.
        let pathname = String(originalUrl || '/').split(/[?#]/, 1)[0];
        try {
            pathname = decodeURIComponent(pathname);
        } catch {
            return '[invalid-request-path]';
        }
        return pathname
            .replace(/(\/api\/integrations\/(?:bnovo|twenty)\/webhooks)(?:\/.*)?$/i, '$1/[REDACTED]')
            .replace(/(\/api\/external-integrations\/webhook\/[^/]+\/[^/]+)(?:\/.*)?$/i, '$1/[REDACTED]')
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .slice(0, 512);
    }

    static getTimestamp() {
        return new Date().toISOString();
    }

    static info(msg) {
        console.log(`\x1b[36m[INFO]\x1b[0m ${this.getTimestamp()} - ${msg}`);
    }

    static error(msg, err) {
        console.error(`\x1b[31m[ERROR]\x1b[0m ${this.getTimestamp()} - ${msg}`, err || '');
    }

    static success(msg) {
        console.log(`\x1b[32m[SUCCESS]\x1b[0m ${this.getTimestamp()} - ${msg}`);
    }

    static warn(msg) {
        console.warn(`\x1b[33m[WARN]\x1b[0m ${this.getTimestamp()} - ${msg}`);
    }

    static debug(msg, data) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`\x1b[90m[DEBUG]\x1b[0m ${this.getTimestamp()} - ${msg}`, data || '');
        }
    }

    static chain(stage, details) {
        console.log(`\x1b[35m[CHAIN]\x1b[0m ${this.getTimestamp()} - ${stage}`);
        if (details) {
            console.log(`        └─ ${JSON.stringify(details, null, 2)}`);
        }
    }
}

module.exports = Logger;
