"""Actual legacy runtime schema -> working candidate schema, strictly offline."""
import sys
sys.dont_write_bytecode = True
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from common import BASE


class OfflineInitializerTest(unittest.TestCase):
    def test_actual_baseline_and_candidate_initializers_preserve_customer_rows(self):
        repo = Path(__file__).parents[2]
        with tempfile.TemporaryDirectory(prefix='ava-product-offline-') as directory:
            root = Path(directory)
            archive = root / 'baseline.tar'
            with archive.open('wb') as stream:
                subprocess.run(['git', '-C', str(repo), 'archive', BASE, 'whatsapp_crm/src', 'whatsapp_crm/package.json'],
                               stdout=stream, check=True, timeout=30)
            with tarfile.open(archive) as handle:
                handle.extractall(root / 'baseline', filter='data')
            app = root / 'baseline/whatsapp_crm'
            (app / 'node_modules').symlink_to((repo / 'whatsapp_crm/node_modules').resolve(), target_is_directory=True)
            database = root / 'crm.db'
            migration = Path(__file__).parent / 'migrations.cjs'
            env = {**os.environ, 'DB_PATH': str(database), 'SESSION_SECRET': 'synthetic-offline-session-secret-at-least-32',
                   'AUTH_ENABLED':'false','AVA_CUSTOMER_ACCESS_ENABLED':'false',
                   'WHATSAPP_CRM_PUBLIC_URL':'https://wh.meludtech.tech',
                   'AVA_RELEASE_OFFLINE': '1', 'NODE_PATH': '/tmp/ava-product-deps-20261017/node_modules'}
            baseline_contract = subprocess.run(['git','-C',str(repo),'show',BASE+':scripts/customer-path-release/schema-contract.json'],
                                               capture_output=True,text=True,check=True,timeout=30).stdout
            script = r'''
const root=process.argv[1],m=require(process.argv[2]);m.prohibitActivity();
for(const name of ['log','info','warn','error','debug'])console[name]=()=>{};
(async()=>{const DB=require(root+'/src/services/database.service');await DB.init();
DB.createSalesWorkspaceTables();
for(const name of ['identity/identity-store','ava-release-flags.service','ava-improvements-flags.service',
'ava-workspace.store','ava-autopilot.store','ava-collaboration.service','ava-availability.service',
'ava-knowledge-review.service','ava-analytics.service','dashboard/metrics','onboarding-state.service',
'customer-studio.service','identity/self-registration.service'])require(root+'/src/services/'+name).ensureSchema();
require(root+'/src/services/whatsapp.service')._ensureReplySchema();
for(const [name,method,args] of JSON.parse(process.argv[3]).initializers)require(root+'/src/services/'+name)[method](args);
// Existing production has reopened this schema many times. Its legacy
// DB.init creates Onyx tables after ensureColumns; the second open adds the
// existing lease index. Reach that baseline fixed point before comparing.
DB.ensureColumns();
DB.run("INSERT INTO instances(id,name) VALUES(9001,'Synthetic retained business')");
DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(9001,'synthetic@c.us','Retained customer')");
DB.run("INSERT INTO messages(instanceId,chatId,senderName,content,role,channel) VALUES(9001,'synthetic@c.us','Synthetic','Retained history','user','whatsapp')");
DB.db.close();process.stdout.write('baseline-created\n');process.exit(0);})().catch(e=>{process.stderr.write(String(e.stack||e.message));process.exit(1)});
'''
            baseline = subprocess.run(['node', '-e', script, str(app), str(migration),baseline_contract], env=env,
                                      capture_output=True, text=True, timeout=60)
            self.assertEqual(baseline.returncode, 0, baseline.stderr[-1000:])
            candidate_env = {**env, 'AVA_APP_ROOT': str(repo / 'whatsapp_crm')}
            first = subprocess.run(['node', str(migration), 'migrate'], env=candidate_env,
                                   capture_output=True, text=True, timeout=60)
            self.assertEqual(first.returncode, 0, first.stdout[-1000:] + first.stderr[-1000:])
            result = json.loads(first.stdout)
            self.assertTrue(result['existingRowsPreserved'])
            self.assertTrue(result['existingColumnsPreserved'])
            self.assertIn('ava_workspace_document_actions', result['afterSnapshot']['tables'])
            self.assertEqual(result['afterSnapshot']['tables']['messages']['count'], 1)
            again = subprocess.run(['node', str(migration), 'migrate'], env=candidate_env,
                                   capture_output=True, text=True, timeout=60)
            self.assertEqual(again.returncode, 0, again.stdout[-1000:])
            retried = json.loads(again.stdout)
            self.assertEqual(result['afterSnapshot'], retried['afterSnapshot'])
            startup = subprocess.run(['node',str(Path(__file__).parent/'startup-probe.cjs')],env=candidate_env,
                                     capture_output=True,text=True,timeout=60)
            self.assertEqual(startup.returncode,0,startup.stdout[-1000:]+startup.stderr[-1000:])
            receipt = json.loads(startup.stdout)
            self.assertTrue(receipt['realAppStart'])
            self.assertTrue(receipt['schemaPreserved'])
            self.assertTrue(receipt['customerRowsPreserved'])


if __name__ == '__main__':
    unittest.main()
