'use strict';
// Invoked only by the local Python integration test with a temporary database.
const { createTestDB } = require('../test-helper');
const Database = require('better-sqlite3');
const DB = require('../../src/services/database.service');
const RAG = require('../../src/services/rag.service');
const Native = require('../../src/services/customer-native-knowledge.service');

async function main() {
    const [path, action, documentId] = process.argv.slice(2);
    const rows = [];
    RAG._indexDocumentChunks = async () => ({ vectorCount: 0 });
    RAG.generateEmbeddings = async chunks => chunks;
    if (action === 'upload') {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Synthetic Alpha'),(8,'Synthetic Beta')");
        for (const businessId of [7, 8]) {
            const base = `https://onyx.example.test/hotel-${businessId}`;
            DB.run(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status,credential_ref,cc_pair_id)
                VALUES (?,?,?,'STAGING',?,?)`, [businessId, `hotel_${businessId}`, base, `FIXTURE_ONYX_${businessId}`, businessId]);
            DB.run(`INSERT INTO onyx_agent_bindings(business_id,role,onyx_base_url,persona_id,document_set_id,
                document_set_name,model_configuration_id,search_tool_id) VALUES (?,'sales',?,?,?, ?,10,3)`,
            [businessId, base, businessId, businessId, `synthetic-${businessId}`]);
            const result = await RAG.processDocument(businessId, Buffer.from(
                `SYNTHETIC_MARKER_${businessId}. Заезд в ${businessId === 7 ? '15:23' : '18:47'}. Только контрольные сведения для локального теста.`),
            'same-name.txt', 'text/plain');
            if (!result.success || !result.nativeSync?.queued) throw new Error('Fixture upload failed');
            rows.push({ businessId, documentId: result.kbId });
        }
        await DB.db.backup(path);
    } else {
        DB.db = new Database(path);
        if (action === 'edit') {
            const chunk = DB.getDocumentChunks(7, Number(documentId))[0];
            await RAG.updateChunk(7, chunk.id, 'SYNTHETIC_UPDATED_7. Заезд в 16:24.', null);
        } else if (action === 'delete') Native.remove(7, Number(documentId));
        else throw new Error('Fixture action invalid');
    }
    DB.db.close();
    process.stdout.write(`PIPELINE_RESULT:${JSON.stringify(rows)}\n`);
}
main().catch(() => { process.stderr.write('FIXTURE_PIPELINE_FAILED\n'); process.exitCode = 1; });
