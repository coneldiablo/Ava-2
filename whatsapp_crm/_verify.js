const DB = require('./src/services/database.service');
const AI = require('./src/services/ai.service');
const FU = require('./src/services/followup.service');

async function test() {
    await DB.init();
    const cols = DB.all('PRAGMA table_info(instances)').map(c => c.name);
    const required = ['followUpEnabled', 'followUpDelay', 'followUpText'];
    const missing = required.filter(c => !cols.includes(c));
    if (missing.length > 0) {
        console.log('MISSING DB COLUMNS:', missing.join(', '));
    } else {
        console.log('OK DB columns:', required.join(', '));
    }
    console.log('AI.getSummary:', typeof AI.getSummary);
    console.log('AI.getNextStep:', typeof AI.getNextStep);
    console.log('FU.start:', typeof FU.start);

    // Check routes file has the new endpoints
    const fs = require('fs');
    const routes = fs.readFileSync('./src/routes/api.routes.js', 'utf8');
    console.log('/ai/summary route:', routes.includes('/ai/summary/') ? 'FOUND' : 'MISSING');
    console.log('/ai/next-step route:', routes.includes('/ai/next-step/') ? 'FOUND' : 'MISSING');
    console.log('FollowUpService imported in app.js:', fs.readFileSync('./src/app.js', 'utf8').includes('followup.service') ? 'YES' : 'NO');
    console.log('FollowUpService.start in app.js:', fs.readFileSync('./src/app.js', 'utf8').includes('FollowUpService.start') ? 'YES' : 'NO');

    process.exit(0);
}

test().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
