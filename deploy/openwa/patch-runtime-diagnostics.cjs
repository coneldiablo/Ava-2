// Bounded diagnostics for the pinned whatsapp-web.js 1.34.7 auth callback.
// Do not mark a session ready or disable the provider's event-bridge guard.
const fs = require('node:fs');
const file = process.argv[2];
let source = fs.readFileSync(file, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('OpenWA patch baseline mismatch');
  source = source.replace(before, after);
}
replaceOnce("'onAppStateHasSyncedEvent',\n            async () => {", "'onAppStateHasSyncedEvent',\n            async () => {\n                try {");
replaceOnce('this.authStrategy.afterAuthReady();\n            },', `this.authStrategy.afterAuthReady();
                } catch (error) {
                    let detail = String(error?.message || error);
                    for (const [key, value] of Object.entries(process.env)) {
                        if (/token|password|secret|api.?key|authorization/i.test(key) && value && value.length >= 8) detail = detail.split(value).join('[REDACTED]');
                    }
                    detail = detail.replace(/(?:Bearer|Basic)\\s+\\S+/gi, '[REDACTED]')
                        .replace(/(https?:\\/\\/)[^/\\s@]+@/gi, '$1[REDACTED]@')
                        .replace(/(?:token|password|secret|api.?key)\\s*[:=]\\s*[^\\s,;]+/gi, '[REDACTED]')
                        .replace(/\\+?\\d{10,15}/g, '[NUMBER]').slice(0, 500);
                    console.error('[AVA_WWEBJS_SYNC_ERROR]', detail);
                }
            },`);
fs.writeFileSync(file, source);
