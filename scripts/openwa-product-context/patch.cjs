'use strict';
// Exact-preimage overlay for the retained OpenWA 0.23.4 image.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const manifest = require('./manifest.json');
const sha = source => crypto.createHash('sha256').update(source).digest('hex');
function requireExact(value, code) { if (!value) throw new Error(code); }
function replaceOnce(source, before, after) {
    requireExact(source.split(before).length === 2, 'PATCH_ANCHOR_DRIFT');
    return source.replace(before, after);
}
const productHelper = `function extractWwebjsProduct(msg) {
    if (msg.type !== 'product' || !msg.productId)
        return undefined;
    return {
        productId: msg.productId,
        ...(msg.title ? { title: msg.title } : {}),
        ...(msg.description ? { description: msg.description } : {}),
        ...(msg.businessOwnerJid ? { businessOwnerJid: msg.businessOwnerJid } : {}),
    };
}
`;
function transform(name, source) {
    const entry=manifest.files.find(file => path.posix.basename(file.target) === name);
    requireExact(entry && sha(source) === entry.before, 'EXACT_PREIMAGE_DRIFT');
    if (name === 'message-mapper.js') {
        source=replaceOnce(source,'exports.buildIncomingMessageBase = buildIncomingMessageBase;\n',
            'exports.buildIncomingMessageBase = buildIncomingMessageBase;\nexports.extractWwebjsProduct = extractWwebjsProduct;\n');
        source=replaceOnce(source,'function buildIncomingMessageBase(msg) {\n',productHelper+'function buildIncomingMessageBase(msg) {\n');
        source=replaceOnce(source,'    return incoming;\n',
            '    const product = extractWwebjsProduct(msg);\n    if (product) {\n        incoming.product = product;\n    }\n    return incoming;\n');
    } else if (name === 'wwebjs-message-events.js') {
        source=replaceOnce(source,`                    incomingMessage.quotedMessage = {
                        id: quoted.id._serialized,
                        body: quoted.body,
                    };`, `                    const product = (0, message_mapper_1.extractWwebjsProduct)(quoted);
                    incomingMessage.quotedMessage = {
                        id: quoted.id._serialized ?? quoted.id.$1 ?? '',
                        body: quoted.body,
                        ...(product ? { product } : {}),
                    };`);
    } else if (name === 'wwebjs-messaging.js') {
        source=replaceOnce(source,'                    out.quotedMessage = { id: quoted.id._serialized, body: quoted.body };',
            `                    const product = (0, message_mapper_1.extractWwebjsProduct)(quoted);
                    out.quotedMessage = { id: quoted.id._serialized ?? quoted.id.$1 ?? '', body: quoted.body,
                        ...(product ? { product } : {}) };`);
    } else if (name === 'message-row.mapper.js') {
        source=replaceOnce(source,'    if (message.call) {\n',
            '    if (message.product) {\n        metadata.product = message.product;\n    }\n    if (message.call) {\n');
    }
    requireExact(!entry.after || sha(source) === entry.after,'PATCH_RESULT_DRIFT');
    return source;
}
function apply(root) {
    // Validate every input and output before changing any file.
    const pending=manifest.files.map(entry => {
        const target=path.join(root,entry.target.replace(/^\/app\//,''));
        return {target,source:transform(path.basename(target),fs.readFileSync(target,'utf8'))};
    });
    const preserved=path.join(root,manifest.preserved.target.replace(/^\/app\//,''));
    requireExact(sha(fs.readFileSync(preserved)) === manifest.preserved.sha256,'MEDIA_FIX_DRIFT');
    for (const {target,source} of pending) fs.writeFileSync(target,source);
}
module.exports = {transform,apply,sha};
if (require.main === module) {
    try { apply(path.resolve(process.argv[2] || '/app')); }
    catch (error) { console.error(error.message); process.exitCode=1; }
}
