'use strict';
// whatsapp-web.js 1.34.7 omits declared MIME when calling the newer
// WhatsApp Web download manager. Its default octet-stream is rejected for
// voice notes/images. Forward the model MIME; retain provider validation.
// Upstream evidence: wwebjs/whatsapp-web.js#201908.
const fs=require('node:fs');
function patch(source){
 const start=source.indexOf('    async downloadMedia() {');
 const end=source.indexOf('\n    async delete(',start);
 if(start<0||end<0)throw Error('OPENWA_MEDIA_BASELINE_MISMATCH');
 const before=source.slice(start,end),needle='                        type: msg.type,\n                        signal: new AbortController().signal,';
 if(before.split(needle).length!==2)throw Error('OPENWA_MEDIA_BASELINE_MISMATCH');
 return source.slice(0,start)+before.replace(needle,'                        type: msg.type,\n                        mimetype: msg.mimetype,\n                        signal: new AbortController().signal,')+source.slice(end);
}
if(require.main===module){const file=process.argv[2];if(!file)throw Error('MESSAGE_SOURCE_REQUIRED');fs.writeFileSync(file,patch(fs.readFileSync(file,'utf8')));}
module.exports={patch};
