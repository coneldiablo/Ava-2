'use strict';
const multer = require('multer');

// Browser FormData serializes bare filename parameters as UTF-8. Legacy
// non-browser uploaders may legitimately use Latin-1. Select the parser's
// charset explicitly; never reinterpret an already-decoded filename string.
const fields = [{ name: 'files', maxCount: 10 }, { name: 'file', maxCount: 10 }];
const parser = charset => multer({ storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, defParamCharset: charset }).fields(fields);
const utf8 = parser('utf8'), latin1 = parser('latin1');
function knowledgeUpload(req, res, next) {
    const encoding = req.get('X-AVA-Upload-Filename-Encoding');
    if (encoding !== undefined && !['utf-8', 'latin1'].includes(encoding)) {
        return res.status(400).json({ success: false, code: 'KNOWLEDGE_FILENAME_ENCODING_INVALID' });
    }
    // Extended filename*=UTF-8''... is decoded by Busboy independently of the
    // default and is preserved correctly in both modes, including Latin names.
    return (encoding === 'utf-8' ? utf8 : latin1)(req, res, next);
}
module.exports = knowledgeUpload;
