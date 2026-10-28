import json
from pathlib import Path
import subprocess

import pytest
import yaml


ROOT = Path(__file__).parents[1]


def test_workspace_override_changes_only_three_non_secret_flags():
    config = yaml.safe_load((ROOT / 'deploy/twenty/docker-compose.workspaces.yml').read_text())
    expected = {'IS_MULTIWORKSPACE_ENABLED': 'true', 'DEFAULT_SUBDOMAIN': 'app',
                'IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS': 'true'}
    assert set(config['services']) == {'server', 'worker'}
    for service in config['services'].values():
        assert service == {'environment': expected}


def test_workspace_tls_enumerates_hosts_and_preserves_edge_headers():
    config = (ROOT / 'deploy/nginx/ava-crm-workspaces-https.conf').read_text()
    assert 'server_name app.crm.meludtech.tech ava-hotels.crm.meludtech.tech;' in config
    assert '*.crm' not in config
    assert 'proxy_pass http://127.0.0.1:3000;' in config
    assert 'proxy_set_header X-Forwarded-For $remote_addr;' in config
    assert 'proxy_set_header X-Forwarded-Proto https;' in config
    assert 'ssl_protocols TLSv1.2 TLSv1.3;' in config


HARNESS = r'''
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const scenario=process.argv[2];
let row={workspaceId:'72600089-b4b4-4db3-a8b9-362f07033467',
 baseUrl:'https://crm.meludtech.tech',apiKeyEncrypted:'fixture-cipher',mode:'live',enabled:1};
if(scenario==='already_migrated') row.baseUrl='https://ava-hotels.crm.meludtech.tech';
if(scenario==='foreign_workspace') row.workspaceId='another-workspace';
const logs=[];let updates=0,closed=false,remoteReads=0;
const DB={get:()=>({isActive:1}),run:(sql,params)=>{assert(sql.startsWith('UPDATE twenty_workspace_links SET baseUrl='));
 assert.equal(params[1],1);updates++;row.baseUrl=params[0];return {changes:1}}};
const store={getIntegration:id=>{assert.equal(id,1);return {...row}}};
const service={_client:()=>({getRecord:async()=>{remoteReads++;
 if(scenario==='connection_changed') row.apiKeyEncrypted='concurrent-change';
 return {data:{task:{id:'b0769054-5bf5-5a8b-bef8-d57319ce5183',status:'DONE',
 avaBusinessId:scenario==='foreign_record'?'2':'1'}}}}})};
function loader(name){return name.includes('database.service')?DB:name.includes('twenty-store')?store:
 name.includes('twenty.service')?service:name==='better-sqlite3'?function(){return {
 transaction:f=>({immediate:()=>f()}),close:()=>{closed=true}}}:undefined}
const control={argv:['node','script',scenario==='preview'?'--preview':'--apply'],exitCode:0};
const context={require:name=>name==='node:module'?{createRequire:()=>loader}:require(name),process:control,
 console:{log:s=>logs.push(JSON.parse(s))}};
(async()=>{await vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),context);
 process.stdout.write(JSON.stringify({logs,updates,closed,remoteReads,exitCode:control.exitCode,row}));})();
'''


def migrate(scenario):
    run = subprocess.run(['node', '-e', HARNESS, str(ROOT / 'scripts/migrate-twenty-workspace-url.cjs'), scenario],
                         check=True, capture_output=True, text=True, timeout=10)
    return json.loads(run.stdout)


@pytest.mark.parametrize('scenario,updates', [('normal', 1), ('already_migrated', 0), ('preview', 0)])
def test_migration_verifies_record_preserves_credentials_and_is_idempotent(scenario, updates):
    result = migrate(scenario)
    assert result['exitCode'] == 0
    assert result['updates'] == updates
    assert result['remoteReads'] == 2
    assert result['row']['apiKeyEncrypted'] == 'fixture-cipher'
    assert result['row']['mode'] == 'live' and result['row']['enabled'] == 1
    assert result['closed'] and result['logs'][-1]['success']


@pytest.mark.parametrize('scenario', ['foreign_workspace', 'foreign_record', 'connection_changed'])
def test_migration_rejects_wrong_scope_or_concurrent_change_without_writing(scenario):
    result = migrate(scenario)
    assert result['exitCode'] == 1
    assert result['updates'] == 0
    assert result['row']['baseUrl'] == 'https://crm.meludtech.tech'
    assert result['closed'] and not result['logs'][-1]['success']
    assert 'fixture-cipher' not in json.dumps(result['logs'])
