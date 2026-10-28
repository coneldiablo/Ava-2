#!/usr/bin/env python3
"""Pinned product journeys CRM/worker/engine release. No environment or schema changes."""
import sys
sys.dont_write_bytecode = True
import argparse, copy, fcntl, hashlib, importlib.util, io, json, os, posixpath, re, shutil, tarfile, tempfile, time
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError, HTTPError

HERE = Path(__file__).resolve()
COMMON = HERE.parent / 'common.py'
if not COMMON.exists(): COMMON = HERE.parent / 'customer-completion-release/common.py'
def checked_module(name, path, digest):
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest: raise RuntimeError('REVIEWED_TOOLING_DRIFT')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
c = checked_module('voice_recovery_common', COMMON, 'b382ea400dd7490f40e9a8eb91ea17639d2aaaf714e871da2691edb6b6ceb58d')
core = c.reviewed_core()
# Borrow only role-independent owner-backup/config/readiness methods, never its
# old inventory, BASE/IMAGES, migration, prepare, activation or rollback methods.
PRIOR = HERE.parent / 'four-service.operator.py'
if not PRIOR.exists(): PRIOR = HERE.parent / 'customer-completion-release/release_operator.py'
sys.modules['common'] = c
prior = checked_module('voice_recovery_reviewed_methods', PRIOR, '94c01b4d243608b1498bb4c529020281adb81fb7ebff74ace25e363c2ef70465')
BASE = 'ed5ada5a61c193f7b643c1d67adfd83ddcdc9607'
IMAGES = {'crm':'sha256:992cc5b55c076c0bc04416cc0b137f3ef3aaeec31a494d513bd9beb1b5300e00',
 'worker':'sha256:d71484206a17f644f41088231cdb80f76bea97fde818373e7b5522daefae2857',
 'engine':'sha256:60ce2614938ec3c1a05c6139e082581cd72e63e3b151e90444eabac643e34df6',
 'admin':'sha256:ad00c820bdb419de026154b513e09e65ea83017960567c53f35b599c649599f3'}
NAMES = c.NAMES
SELECTED = ('worker','crm','engine')
ENV_ADDITIONS = ()
# Exact final task paths only; no glob can add a runtime file to a release.
CRM = {'src/services/identity/customer-role-boundary.js':'M','src/routes/telephony-internal.routes.js': 'M', 'src/routes/telephony.routes.js': 'M', 'src/services/client-identity.service.js': 'M', 'src/services/dashboard/metrics.js': 'M', 'src/services/database.service.js': 'M', 'src/services/postcall-followup.service.js': 'M', 'src/services/rag.service.js': 'M', 'src/services/sales-brain.service.js': 'M', 'src/services/telephony/diagnostics.js': 'M', 'src/services/telephony/host-client.js': 'M', 'src/services/telephony/service.js': 'M', 'src/services/telephony/store.js': 'M', 'src/services/telephony/worker.js': 'M', 'src/services/telephony/external-sip.js': 'A'}
ENGINE = {'src/mcp_servers/sales_brain_mcp_server.py': 'M', 'src/tools/context.py': 'M', 'src/tools/mcp_tool.py': 'M'}
WORKER = dict(CRM)
# Two worker files intentionally retained older committed bytes in prior
# CRM-only releases. Exact role/ref/hash pins; no runtime hash exception.
PREIMAGE_SOURCES = {'worker': {
 'src/services/identity/customer-role-boundary.js': {
  'sourceRef':'060bd8322f791791f25dfab749099ae510e7c0a3',
  'sha256':'9a3baafb15411a0648fb49122de183ada4a52c157eef302748ba45dc47f47795'},
 'src/services/rag.service.js': {
  'sourceRef':'41fb6dfc8c221bd9fe9bfb4db5748e18caf8b3a0',
  'sha256':'d05ba2a1ed1c254370c1bbe78eb7b2511af0b5bf91c73e33fa12d378fa4c9119'}}}
FRONTEND = {'whatsapp_crm/frontend/src/App.tsx': 'M', 'whatsapp_crm/frontend/src/api/telephony.ts': 'M', 'whatsapp_crm/frontend/src/components/PostCallMessageSettings.tsx': 'M', 'whatsapp_crm/frontend/src/components/TelephonyPanel.css': 'M', 'whatsapp_crm/frontend/src/components/TelephonyPanel.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Activity.tsx': 'M', 'whatsapp_crm/frontend/src/pages/AllLeads.tsx': 'M', 'whatsapp_crm/frontend/src/pages/AssistantBuilder.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Autopilot.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Calls.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Channels.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Conversations.tsx': 'M', 'whatsapp_crm/frontend/src/pages/CustomerIdentities.tsx': 'M', 'whatsapp_crm/frontend/src/pages/CustomerIntelligence.css': 'M', 'whatsapp_crm/frontend/src/pages/CustomerIntelligence.tsx': 'M', 'whatsapp_crm/frontend/src/pages/CustomerSetup.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Dashboard.css': 'M', 'whatsapp_crm/frontend/src/pages/Dashboard.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Deals.tsx': 'M', 'whatsapp_crm/frontend/src/pages/KnowledgeBase.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Opportunities.tsx': 'M', 'whatsapp_crm/frontend/src/pages/QuickReplies.tsx': 'M', 'whatsapp_crm/frontend/src/pages/Studio.tsx': 'M', 'whatsapp_crm/frontend/src/pages/TodayWorkspace.css': 'M', 'whatsapp_crm/frontend/src/pages/TodayWorkspace.tsx': 'M', 'whatsapp_crm/frontend/src/pages/dashboardApi.ts': 'M', 'whatsapp_crm/frontend/src/workspaceNavigation.ts': 'M', 'whatsapp_crm/frontend/src/components/ExternalSipSettings.tsx': 'A', 'whatsapp_crm/frontend/src/components/TimeZoneSelect.tsx': 'A', 'whatsapp_crm/frontend/src/customerDisplay.ts': 'A', 'whatsapp_crm/frontend/src/pages/DashboardCharts.tsx': 'A'}
CONFIG_SOURCE = 'config/ai-agent.yaml'
CONFIG_PATH = '/root/ava-releases/ava-autopilot-20261003/engine-config/ai-agent.yaml'
CONFIG_SHA = '55e4e7840f95f3a7fdf57d299edbb6c1fcffe3f5402bfdb09565b409b06bd11b'
HOST_SEPARATE = {'scripts/telephony/agent.py':'M','scripts/telephony/external_sip.py':'A','scripts/telephony/install_external_sip.py':'A'}
OFFLINE = {'migrations.cjs':'scripts/customer-completion-release/migrations.cjs',
 'startup-probe.cjs':'scripts/customer-completion-release/startup-probe.cjs'}
require = c.require

def safe_error(error,fallback):
    code=str(error)
    return code if re.fullmatch(r'[A-Z0-9_]+(?::(?:crm|worker|engine|admin)(?::(?:User|Entrypoint|Cmd|WorkingDir|Healthcheck|StopSignal|StopTimeout))?)?',code) else fallback

def failure_details(error):
    result={'code':safe_error(error,'ACTIVATION_CHECK_FAILED'),'exceptionType':type(error).__name__}
    if isinstance(error,HTTPError):result['httpStatus']=error.code
    return result

def transient_readiness(error):
    if isinstance(error,HTTPError):return error.code in (408,425,429,500,502,503,504)
    if isinstance(error,(URLError,TimeoutError,ConnectionError)):return True
    return isinstance(error,RuntimeError) and str(error) in ('ENGINE_NOT_READY','CRM_UNHEALTHY','COMMAND_FAILED')

def scope():
    return {'crm':CRM, 'worker':WORKER, 'engine':ENGINE}

def normalized_host_config(value):
    result=copy.deepcopy(value); binds=result.get('Binds')
    if binds is not None:
        require(isinstance(binds,list) and all(isinstance(v,str) for v in binds),'HOST_BINDS_INVALID')
        targets=[]
        for value in binds:
            parts=value.split(':');require(len(parts) in (2,3),'HOST_BIND_INVALID')
            require(parts[1].startswith('/') and posixpath.normpath(parts[1])==parts[1],'HOST_BIND_DESTINATION_INVALID')
            targets.append(parts[1])
        require(len(targets)==len(set(targets)),'HOST_BIND_DESTINATION_COLLISION')
        result['Binds']=sorted(binds)
    return result

def copy_context(source,target):
    # Fresh mtimes avoid BuildKit's demonstrated same-size epoch-mtime stale COPY.
    shutil.copytree(source,target,copy_function=shutil.copyfile)

SNAPSHOT_PROOF = r'''const S=require('/app/node_modules/better-sqlite3'),vec=require('/app/node_modules/sqlite-vec');
const {snapshot}=require('/release/migrations.cjs'),integrity=process.argv[2]==='integrity';
const db=new S(process.env.DB_PATH,{readonly:!integrity,fileMustExist:true});vec.load(db);
const quote=n=>'"'+n.replace(/"/g,'""')+'"';
try{
 const tableTypes=Object.fromEntries(db.prepare('PRAGMA table_list').all().filter(t=>t.schema==='main').map(t=>[t.name,t.type]));
 const parents=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all().filter(t=>{
  const prefix=(t.sql||'').split('(')[0];return tableTypes[t.name]==='virtual'&&/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(prefix)&&/\bUSING\s+fts5\s*$/i.test(prefix);
 });
 const ftsIntegrity={};
 if(integrity){
  if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('CLONE_SQLITE_INTEGRITY_FAILED');
  // rank=1 verifies external-content FTS against its content as well as the
  // internal segment structure. Only this private clone is writable.
  for(const {name} of parents){db.prepare(`INSERT INTO ${quote(name)}(${quote(name)},rank) VALUES('integrity-check',1)`).run();ftsIntegrity[name]=true;}
 }
 console.log(JSON.stringify({ok:true,snapshot:snapshot(db),tableTypes,ftsIntegrity}));
}finally{db.close();}'''

def compare_startup_snapshots(before,after):
    require(before.get('ok') is True and after.get('ok') is True,'STARTUP_SNAPSHOT_FAILED')
    b,a=before['snapshot'],after['snapshot']
    require(b['metadata']==a['metadata'] and b['objects']==a['objects'] and set(b['tables'])==set(a['tables']), 'STARTUP_SCHEMA_OR_ROWS_CHANGED')
    require(before.get('tableTypes')==after.get('tableTypes'),'STARTUP_TABLE_TYPES_CHANGED')
    types=before.get('tableTypes',{});parents=set()
    for obj in b['objects']:
        prefix=(obj.get('sql') or '').split('(',1)[0]
        if obj['type']=='table' and types.get(obj['name'])=='virtual' and re.match(r'^\s*CREATE\s+VIRTUAL\s+TABLE\b',prefix,re.I) and re.search(r'\bUSING\s+fts5\s*$',prefix,re.I):parents.add(obj['name'])
    require(after.get('ftsIntegrity')=={name:True for name in parents},'CLONE_FTS_INTEGRITY_REQUIRED')
    physical=[]
    for name,old in b['tables'].items():
        new=a['tables'][name]
        require(old['columns']==new['columns'] and old['rowid']==new['rowid'],'STARTUP_SCHEMA_OR_ROWS_CHANGED')
        if old==new:continue
        parent=next((p for p in parents if name in {p+'_'+suffix for suffix in ('data','idx')}),None)
        require(types.get(name)=='shadow' and parent is not None and b['tables'][parent]==a['tables'][parent], 'STARTUP_SCHEMA_OR_ROWS_CHANGED')
        physical.append(name)
    return sorted(physical)

def source_scope(repo,candidate):
    c.git(repo,'merge-base','--is-ancestor',BASE,candidate)
    allowed={'whatsapp_crm/'+name:status for name,status in CRM.items()};allowed.update(ENGINE);allowed.update(FRONTEND);allowed[CONFIG_SOURCE]='M';allowed.update(HOST_SEPARATE)
    tokens=c.git(repo,'diff','--no-renames','--name-status','-z',BASE,candidate).split(b'\0')
    require(tokens[-1]==b'' and len(tokens[:-1])%2==0,'SOURCE_DIFF_INVALID')
    changed={}
    for index in range(0,len(tokens)-1,2):
        status,name=tokens[index].decode(),tokens[index+1].decode();c.relative(name)
        if name in allowed: require(status==allowed[name],'EXACT_RUNTIME_STATUS_REQUIRED');changed[name]=status
        else:require(status in ('A','M','D') and (name.startswith(('whatsapp_crm/frontend/tests/','whatsapp_crm/tests/','tests/','docs/','scripts/'))
            or name=='TASK_STATUS.md' or name.startswith('whatsapp_crm/frontend/src/') and re.search(r'\.(?:test|spec)\.[cm]?[jt]sx?$',name)),'OUTSIDE_PRODUCT_JOURNEYS_SCOPE')
    for name in ('whatsapp_crm/package.json','whatsapp_crm/package-lock.json','whatsapp_crm/frontend/package.json',
                 'whatsapp_crm/frontend/package-lock.json','requirements.txt','requirements-optional.txt'):
        require(c.blob(repo,BASE,name,optional=True)==c.blob(repo,candidate,name,optional=True),'DEPENDENCIES_CHANGED')
    require(set(changed)==set(allowed),'EXACT_RUNTIME_CHANGESET_REQUIRED')

def preimage(repo,role,name):
    source=('whatsapp_crm/' if role in ('crm','worker') else '')+name
    pin=PREIMAGE_SOURCES.get(role,{}).get(name)
    ref=pin['sourceRef'] if pin else BASE
    if pin:c.git(repo,'merge-base','--is-ancestor',ref,BASE)
    data=c.blob(repo,ref,source,optional=not bool(pin))
    if pin:require(data is not None and c.sha(data)==pin['sha256'],'HISTORICAL_PREIMAGE_SOURCE_DRIFT')
    return data

def preimage_sources(role):
    return copy.deepcopy(PREIMAGE_SOURCES.get(role,{}))

def pack(args):
    repo=args.repo.resolve();candidate=c.commit(repo,args.candidate);source_scope(repo,candidate)
    frontend=c.tree(args.frontend_dist);receipt=json.loads(args.frontend_receipt.read_text());c.validate_receipt(receipt,candidate,frontend)
    builder='scripts/customer-completion-release/build_frontend.py'
    require(receipt.get('builtFromFreshGitExport') is True and receipt.get('builderSha256')==c.sha(c.blob(repo,candidate,builder))
        and receipt.get('sourceTree')==c.git(repo,'rev-parse',candidate+':whatsapp_crm/frontend').decode().strip()
        and receipt.get('lockSha256')==c.sha(c.blob(repo,candidate,'whatsapp_crm/frontend/package-lock.json')),'FRESH_FRONTEND_REQUIRED')
    code=c.blob(repo,candidate,'scripts/'+HERE.name);require(c.sha(code)==c.file_sha(HERE),'UNCOMMITTED_OPERATOR')
    services={};payload={}
    for role,paths in scope().items():
        files={};preimages={}
        for name,status in paths.items():
            source=('whatsapp_crm/' if role in ('crm','worker') else '')+name
            data=c.blob(repo,candidate,source);old=preimage(repo,role,name)
            require((old is None)==(status=='A'),'EXACT_BASE_FILE_STATUS_REQUIRED')
            files[name]=c.sha(data);preimages[name]=None if old is None else c.sha(old);payload['payload/'+role+'/'+name]=data
        if role=='crm':
            for name in frontend:
                data=(args.frontend_dist/name).read_bytes();files['frontend/dist/'+name]=c.sha(data);payload['payload/crm/frontend/dist/'+name]=data
        services[role]={'files':files,'preimages':preimages,'preimageSources':preimage_sources(role)}
    tooling={'tooling/'+HERE.name:code,'tooling/common.py':c.blob(repo,candidate,'scripts/customer-completion-release/common.py'),
        'tooling/four-service.operator.py':c.blob(repo,candidate,'scripts/customer-completion-release/release_operator.py'),
        'neuro-gemini-release/release_operator.py':c.blob(repo,candidate,'scripts/neuro-gemini-release/release_operator.py')}
    for name,source in OFFLINE.items():
        data=c.blob(repo,candidate,source);require(data==c.blob(repo,BASE,source),'FROZEN_OFFLINE_TOOL_CHANGED');tooling['tooling/'+name]=data
    configuration={}
    for name,ref in [('base.yaml',BASE),('candidate.yaml',candidate)]:
        data=c.blob(repo,ref,CONFIG_SOURCE);payload['configuration/'+name]=data;configuration[name]=c.sha(data)
    manifest={'kind':'product-journeys-20261020','baseCommit':BASE,'baseImages':IMAGES,'candidateCommit':candidate,
        'services':services,'frontendReceipt':receipt,'environmentAdditionNames':list(ENV_ADDITIONS),'schemaChanges':False,
        'configuration':{'path':CONFIG_PATH,'beforeSha256':CONFIG_SHA,'files':configuration},
        'hostSeparateFiles':{n:c.sha(c.blob(repo,candidate,n)) for n in HOST_SEPARATE},
        'tooling':{name:c.sha(data) for name,data in tooling.items()}}
    entries={**payload,**tooling,'manifest.json':c.canonical(manifest)+b'\n'};require(not args.output.exists(),'OUTPUT_EXISTS')
    with tarfile.open(args.output,'w') as tar:
        for name,data in sorted(entries.items()):
            c.relative(name);info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;info.uid=info.gid=info.mtime=0;info.uname=info.gname='';tar.addfile(info,io.BytesIO(data))
    return {'phase':'packed','candidateCommit':candidate,'archiveSha256':c.file_sha(args.output),'manifestSha256':c.sha(entries['manifest.json']),
        'approvedHistoricalPreimages':copy.deepcopy(PREIMAGE_SOURCES)}

# Executed only inside the pinned candidate engine with network=none. The host
# needs no YAML dependency. All unrelated bytes (comments/order included) survive.
YAML_PATCH_SCRIPT = r'''import copy,difflib,hashlib,json,pathlib,sys,yaml
CONTEXTS=('demo_google_live','unified_sales_agent')
NEW_TOOLS=['mcp_sales_draft_followup','mcp_sales_send_followup']
REGISTRY=[{'name':'draft_followup','expose_as':NEW_TOOLS[0],'speech_field':'spoken'},
          {'name':'send_followup','expose_as':NEW_TOOLS[1],'speech_field':'spoken'}]
def require(value,code):
 if not value:raise RuntimeError(code)
class UniqueLoader(yaml.SafeLoader):pass
def mapping(loader,node,deep=False):
 result={}
 for key,value in node.value:
  k=loader.construct_object(key,deep=deep);require(k not in result,'YAML_DUPLICATE_KEY');result[k]=loader.construct_object(value,deep=deep)
 return result
UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,mapping)
def load(text):return yaml.load(text,Loader=UniqueLoader)
def node_at(text,path):
 node=yaml.compose(text,Loader=UniqueLoader)
 for key in path:
  require(isinstance(node,yaml.MappingNode),'YAML_PATH_INVALID')
  matches=[v for k,v in node.value if k.value==key];require(len(matches)==1,'YAML_PATH_REQUIRED');node=matches[0]
 return node
def replacements(before,after):
 a,b=before.splitlines(keepends=True),after.splitlines(keepends=True);changes=[]
 for tag,i,j,k,l in difflib.SequenceMatcher(a=a,b=b,autojunk=False).get_opcodes():
  if tag!='equal':
   require(tag=='replace' and i<j and k<l,'YAML_PROMPT_SCOPE_INVALID');changes.append((''.join(a[i:j]),''.join(b[k:l])))
 require(len(changes)==3,'YAML_PROMPT_CHANGE_COUNT');return changes
def apply_replacements(text,changes):
 for old,new in changes:require(text.count(old)==1,'YAML_PROMPT_PREIMAGE_REQUIRED');text=text.replace(old,new,1)
 return text
def add_tools(items):
 require(isinstance(items,list) and all(n not in items for n in NEW_TOOLS),'YAML_TOOL_PREIMAGE_INVALID')
 at=items.index('mcp_sales_draft_whatsapp_followup');return items[:at]+NEW_TOOLS+items[at:]
def add_registry(items):
 require(isinstance(items,list) and not any(x.get('name') in ('draft_followup','send_followup') or x.get('expose_as') in NEW_TOOLS for x in items),'YAML_REGISTRY_PREIMAGE_INVALID')
 places=[i for i,x in enumerate(items) if x.get('name')=='draft_whatsapp_followup'];require(len(places)==1,'YAML_REGISTRY_ANCHOR_REQUIRED');at=places[0];return items[:at]+copy.deepcopy(REGISTRY)+items[at:]
def patch_config(live,base,candidate):
 b,a,v=load(base),load(candidate),load(live);expected_base=copy.deepcopy(b);expected=copy.deepcopy(v)
 for name in CONTEXTS:
  expected_base['contexts'][name]['tools']=add_tools(b['contexts'][name]['tools'])
  expected['contexts'][name]['tools']=add_tools(v['contexts'][name]['tools'])
 expected_base['mcp']['servers']['sales_brain']['tools']=add_registry(b['mcp']['servers']['sales_brain']['tools'])
 expected['mcp']['servers']['sales_brain']['tools']=add_registry(v['mcp']['servers']['sales_brain']['tools'])
 path=('contexts','demo_google_live','prompt');before=b['contexts']['demo_google_live']['prompt'];after=a['contexts']['demo_google_live']['prompt']
 expected_base['contexts']['demo_google_live']['prompt']=after
 require(expected_base==a,'YAML_CANDIDATE_OUTSIDE_APPROVED_SCOPE')
 expected['contexts']['demo_google_live']['prompt']=apply_replacements(v['contexts']['demo_google_live']['prompt'],replacements(before,after))
 edits=[]
 for name in CONTEXTS:
  node=node_at(live,('contexts',name,'tools'));anchors=[n for n in node.value if n.value=='mcp_sales_draft_whatsapp_followup'];require(len(anchors)==1,'YAML_TOOL_ANCHOR_REQUIRED')
  start=live.rfind('\n',0,anchors[0].start_mark.index)+1;line=live[start:anchors[0].start_mark.index];indent=line[:len(line)-len(line.lstrip())]
  edits.append((start,start,''.join(indent+'- '+tool+'\n' for tool in NEW_TOOLS)))
 registry=node_at(live,('mcp','servers','sales_brain','tools'))
 anchors=[n for n in registry.value if any(k.value=='name' and value.value=='draft_whatsapp_followup' for k,value in n.value)];require(len(anchors)==1,'YAML_REGISTRY_ANCHOR_REQUIRED')
 start=live.rfind('\n',0,anchors[0].start_mark.index)+1;line=live[start:anchors[0].start_mark.index];indent=line[:len(line)-len(line.lstrip())]
 text=''.join(indent+'- name: '+item['name']+'\n'+indent+'  expose_as: '+item['expose_as']+'\n'+indent+'  speech_field: spoken\n' for item in REGISTRY)
 edits.append((start,start,text))
 node=node_at(live,path)
 # The pinned live prompt can be semantically identical but single-quoted and
 # wrapped by a prior safe_dump. Source raw folded-block fragments cannot match
 # that representation. Replace ONLY this approved scalar span, after the exact
 # parsed replacements above, with a correctly indented literal block.
 start=live.rfind('\n',0,node.start_mark.index)+1;prefix=live[start:node.start_mark.index]
 indent=' '*(len(prefix)-len(prefix.lstrip())+2)
 value=expected['contexts']['demo_google_live']['prompt']
 trailing=len(value)-len(value.rstrip('\n'));chomp='-' if trailing==0 else '+' if trailing>1 else ''
 raw='|'+chomp+'\n'+''.join(indent+line for line in value.splitlines(keepends=True))
 if not raw.endswith('\n'):raw+='\n'
 # An old quoted node ends before its line ending; consume that existing newline
 # as part of the changed scalar rather than accidentally adding a blank line.
 end=node.end_mark.index
 if end<len(live) and live[end]=='\n':end+=1
 edits.append((node.start_mark.index,end,raw))
 output=live
 for start,end,text in sorted(edits,reverse=True):output=output[:start]+text+output[end:]
 require(load(output)==expected,'YAML_SEMANTIC_PROJECTION_FAILED')
 return output,{'semanticProjectionVerified':True,'unrelatedBytesPreserved':True,'changedPaths':['contexts.demo_google_live.prompt','contexts.demo_google_live.tools','contexts.unified_sales_agent.tools','mcp.servers.sales_brain.tools']}
if __name__=='__main__':
 root=pathlib.Path('/release');result,receipt=patch_config((root/'live-before.yaml').read_text(),(root/'base.yaml').read_text(),(root/'candidate.yaml').read_text())
 (root/'staged.yaml').write_text(result)
 from src.config import load_config
 config=load_config(str(root/'staged.yaml'))
 receipt['runtimeConfigLoaded']=True;receipt['beforeSha256']=hashlib.sha256((root/'live-before.yaml').read_bytes()).hexdigest();receipt['afterSha256']=hashlib.sha256((root/'staged.yaml').read_bytes()).hexdigest()
 print(json.dumps(receipt,sort_keys=True))
'''

class Release:
    config_inputs=prior.Operator.config_inputs
    binding_hashes=prior.Operator.binding_hashes
    engine_databases=prior.Operator.engine_databases
    engine_backup=prior.Operator.engine_backup
    crm_backup=prior.Operator.crm_backup
    ready=prior.Operator.ready
    clone_for_migration=prior.Operator.clone_for_migration
    def __init__(self,args):
        self.root=args.root.absolute();self.root.mkdir(mode=0o700,parents=True,exist_ok=True);require(not self.root.is_symlink(),'ROOT_SYMLINK');self.root.chmod(0o700);core.LOG_ROOT=self.root;prior.core.LOG_ROOT=self.root
        self.bundle=args.bundle.absolute();self.manifest_sha=args.manifest_sha256
        require(c.file_sha(self.bundle/'manifest.json')==self.manifest_sha,'MANIFEST_HASH_REQUIRED');self.m=json.loads((self.bundle/'manifest.json').read_text());self.bundle_guard()
    def run(self,command,**kwargs):return core.run(command,**kwargs)
    def inspect(self,name):return json.loads(self.run(['docker','inspect',name]))[0]
    def rows(self):return {role:self.inspect(name) for role,name in NAMES.items()}
    def bundle_guard(self):
        require(c.file_sha(self.bundle/'manifest.json')==self.manifest_sha,'MANIFEST_CHANGED');m=self.m
        require(m['kind']=='product-journeys-20261020' and m['baseCommit']==BASE and m['baseImages']==IMAGES
            and re.fullmatch('[0-9a-f]{40}',m['candidateCommit']) and set(m['services'])==set(SELECTED) and m.get('schemaChanges') is False,'MANIFEST_SCOPE_INVALID')
        require(m.get('environmentAdditionNames')==list(ENV_ADDITIONS),'ENV_SCOPE_CHANGED')
        for role,paths in scope().items():
            service=m['services'][role];files=service['files'];require(set(service['preimages'])==set(paths),'PREIMAGE_SCOPE_CHANGED')
            require(service.get('preimageSources')==preimage_sources(role),'HISTORICAL_PREIMAGE_SCOPE_DRIFT')
            require(all(service['preimages'].get(name)==pin['sha256'] for name,pin in preimage_sources(role).items()),'HISTORICAL_PREIMAGE_HASH_DRIFT')
            require(set(files)==set(paths)|({'frontend/dist/'+name for name in m['frontendReceipt']['files']} if role=='crm' else set()),'PAYLOAD_SCOPE_CHANGED')
            require(c.tree(self.bundle/'payload'/role)==files,'PAYLOAD_CHANGED')
            for name,status in paths.items():
                old=service['preimages'][name];require(old is None if status=='A' else isinstance(old,str) and re.fullmatch('[0-9a-f]{64}',old),'PREIMAGE_INVALID')
        require(m.get('configuration',{}).get('path')==CONFIG_PATH and m['configuration'].get('beforeSha256')==CONFIG_SHA
            and set(m['configuration']['files'])=={'base.yaml','candidate.yaml'} and c.tree(self.bundle/'configuration')==m['configuration']['files'],'CONFIGURATION_PAYLOAD_DRIFT')
        require(set(m.get('hostSeparateFiles',{}))==set(HOST_SEPARATE) and all(re.fullmatch('[a-f0-9]{64}',v) for v in m['hostSeparateFiles'].values()),'HOST_SCOPE_CHANGED')
        for name,digest in m['tooling'].items():c.relative(name);require(c.file_sha(self.bundle/name)==digest,'TOOLING_CHANGED')
        require(m['tooling']['tooling/'+HERE.name]==c.file_sha(HERE) and m['tooling']['tooling/common.py']==c.file_sha(COMMON)
            and m['tooling']['tooling/four-service.operator.py']==c.file_sha(PRIOR)
            and m['tooling']['neuro-gemini-release/release_operator.py']==c.CORE_HASH,'EXECUTING_TOOLING_DRIFT')
    def others(self):
        ids=self.run(['docker','ps','-aq']).split();rows=json.loads(self.run(['docker','inspect',*ids])) if ids else []
        return {r['Name']:[r['Id'],r['Image'],r['State']['Running'],r['State'].get('StartedAt'),r.get('RestartCount')]
            +[{'env':core.envmap(r),'mounts':r['Mounts'],'hostConfig':normalized_host_config(r['HostConfig']),
                'networks':sorted(r['NetworkSettings']['Networks']),
                'process':{k:r['Config'].get(k) for k in ('User','Entrypoint','Cmd','WorkingDir','Healthcheck','StopSignal','StopTimeout')}}]
            for r in rows if r['Name'].lstrip('/') not in {NAMES[role] for role in SELECTED}}
    def prepare_configuration(self,rows,image,inputs):
        path=Path(CONFIG_PATH);require(path.is_file() and not path.is_symlink() and c.file_sha(path)==CONFIG_SHA,'PINNED_CONFIGURATION_REQUIRED')
        mount=[m for m in rows['engine']['Mounts'] if m['Destination']=='/app/config']
        require(len(mount)==1 and mount[0]['Type']=='bind' and Path(mount[0]['Source']).resolve()==path.parent.resolve(),'CONFIGURATION_BIND_CHANGED')
        require(CONFIG_PATH in inputs['bindings'] and isinstance(inputs['bindings'][CONFIG_PATH],list),'CONFIGURATION_INPUT_REQUIRED')
        directory=self.root/'configuration';require(not directory.exists(),'CONFIGURATION_PREPARE_EXISTS');directory.mkdir(mode=0o700)
        for name in ('base.yaml','candidate.yaml'):
            target=directory/name;target.write_bytes((self.bundle/'configuration'/name).read_bytes());target.chmod(0o600)
        before=directory/'live-before.yaml';before.write_bytes(path.read_bytes());before.chmod(0o600)
        envfile=self.root/'engine-before.private.env';core.private_env(envfile,core.envmap(rows['engine']))
        receipt=json.loads(self.run(['docker','run','--rm','--network','none','--read-only','--user','0:0',
            '--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--env-file',str(envfile),'-e','PYTHONDONTWRITEBYTECODE=1',
            '--mount',f'type=bind,src={directory},dst=/release','--entrypoint','python',image,'-c',YAML_PATCH_SCRIPT],timeout=60))
        staged=directory/'staged.yaml';require(staged.is_file() and not staged.is_symlink(),'STAGED_CONFIGURATION_MISSING');staged.chmod(0o600)
        require(receipt.get('semanticProjectionVerified') is True and receipt.get('unrelatedBytesPreserved') is True and receipt.get('runtimeConfigLoaded') is True
            and receipt.get('beforeSha256')==CONFIG_SHA and receipt.get('afterSha256')==c.file_sha(staged) and c.file_sha(path)==CONFIG_SHA,'CONFIGURATION_PREPARE_FAILED')
        stat=path.stat();parent=path.parent.stat()
        return {'beforeFile':str(before),'stagedFile':str(staged),'beforeSha256':CONFIG_SHA,'afterSha256':c.file_sha(staged),
            'owner':[stat.st_uid,stat.st_gid,stat.st_mode&0o777],
            'directory':[parent.st_dev,parent.st_ino,parent.st_uid,parent.st_gid,parent.st_mode&0o777], 'receipt':receipt}
    def configuration_guard(self,p,recovery=False):
        state=p['configuration'];path=Path(CONFIG_PATH)
        require(path.is_file() and not path.is_symlink(),'CONFIGURATION_PATH_INVALID');stat=path.stat();parent=path.parent.stat()
        require([stat.st_uid,stat.st_gid,stat.st_mode&0o777]==state['owner'] and
            [parent.st_dev,parent.st_ino,parent.st_uid,parent.st_gid,parent.st_mode&0o777]==state['directory'],'CONFIGURATION_METADATA_DRIFT')
        digest=c.file_sha(path);require(digest in (CONFIG_SHA,state['afterSha256']),'LIVE_CONFIGURATION_DRIFT')
        require(c.file_sha(state['beforeFile'])==CONFIG_SHA and c.file_sha(state['stagedFile'])==state['afterSha256'],'PRIVATE_CONFIGURATION_DRIFT')
        expected=copy.deepcopy(p['inputs']);require(CONFIG_PATH in expected['bindings'],'CONFIGURATION_INPUT_REQUIRED')
        expected['bindings'][CONFIG_PATH][0]=digest
        # No broad exception for the config directory or sibling providers/secrets.
        require(self.inputs(p['before'])==expected,'CONFIG_INPUT_DRIFT')
    def switch_configuration(self,p,rollback=False):
        state=p['configuration'];target=Path(CONFIG_PATH);current=c.file_sha(target)
        wanted=CONFIG_SHA if rollback else state['afterSha256'];source=Path(state['beforeFile'] if rollback else state['stagedFile'])
        require(current in (CONFIG_SHA,state['afterSha256']) and c.file_sha(source)==wanted,'CONFIGURATION_REPLACEMENT_DRIFT')
        # Stop only after both actual ARI/Asterisk call and provider-session counts
        # are zero. A running-but-unreachable engine is never assumed idle.
        core.idle();command,cwd,service=core.compose(p['before']['engine'])
        row=self.inspect(NAMES['engine']);require(row['Image'] in (IMAGES['engine'],p['images']['engine']),'ENGINE_STOP_IMAGE_DRIFT')
        self.run(command+['stop','--timeout','30',service],cwd=cwd,timeout=45)
        require(not self.inspect(NAMES['engine'])['State']['Running'],'ENGINE_QUIESCE_FAILED')
        self.configuration_guard(p,recovery=rollback)
        if current!=wanted:
            require(c.file_sha(target)==current,'CONFIGURATION_CHANGED_BEFORE_REPLACE')
            with tempfile.NamedTemporaryFile(dir=target.parent,prefix='.ava-product-journeys-',delete=False) as stream:
                temporary=Path(stream.name);stream.write(source.read_bytes());stream.flush();os.fsync(stream.fileno())
            os.chown(temporary,*state['owner'][:2]);temporary.chmod(state['owner'][2]);os.replace(temporary,target)
            fd=os.open(target.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
        require(c.file_sha(target)==wanted,'CONFIGURATION_READBACK_FAILED');self.configuration_guard(p,recovery=rollback)
        core.idle()  # Recheck Asterisk immediately before the engine up command.
    def inputs(self,rows):return {'files':self.config_inputs(rows),'bindings':self.binding_hashes(rows)}
    def database(self,rows):
        paths=[]
        for role in ('crm','worker'):
            row=rows[role];require(core.envmap(row).get('DB_PATH')=='/app/data/crm_v2.db','DATABASE_ENV_CHANGED')
            mounts=[x for x in row['Mounts'] if x['Destination']=='/app/data'];require(len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['RW'],'DATABASE_MOUNT_CHANGED')
            file=Path(mounts[0]['Source'])/'crm_v2.db';require(file.is_file() and not file.is_symlink(),'DATABASE_INVALID');paths.append(file)
        require(paths[0].samefile(paths[1]),'CRM_WORKER_DATABASE_SPLIT');return paths[0]
    def metadata(self,file):
        require(file.is_file() and not file.is_symlink(),'DATABASE_INVALID');s=file.stat();p=file.parent.stat()
        return {'identity':[s.st_dev,s.st_ino],'owner':[s.st_uid,s.st_gid,s.st_mode&0o777],'directory':[p.st_uid,p.st_gid,p.st_mode&0o777]}
    def db_guard(self,p):
        for name,expected in p['databaseMetadata'].items():
            file=Path(name);require(self.metadata(file)==expected,'DATABASE_METADATA_CHANGED')
            for suffix in ('-wal','-shm'):
                side=Path(name+suffix)
                if side.exists():require(not side.is_symlink() and self.metadata(side)['owner']==expected['owner'],'DATABASE_SIDECAR_CHANGED')
    def input_guard(self,p,recovery=False):
        self.bundle_guard();self.db_guard(p);self.configuration_guard(p,recovery=recovery)
        if not recovery:require(self.others()==p['otherContainers'],'OTHER_CONTAINERS_CHANGED')
    def load(self):
        p=json.loads((self.root/'prepared.private.json').read_text());require(p['manifestSha256']==self.manifest_sha,'PREPARED_MANIFEST_DRIFT');return p
    def host_guard(self,role,before,after):
        if normalized_host_config(before)==normalized_host_config(after):return
        changed=sorted(k for k in set(before)|set(after) if (k in before)!=(k in after) or before.get(k)!=after.get(k))
        c.private_json(self.root/(role+'-host-config-drift.private.json'),{'before':before,'after':after,'changedKeys':changed})
        raise RuntimeError('HOST_CONFIG_CHANGED:'+role)
    def expected_env(self,p,role,rollback=False):
        return core.envmap(p['before'][role])
    def offline(self,p):
        backup=self.crm_backup(Path(p['database']),'prepare-crm-backup',IMAGES['crm']);uid,gid,_=p['databaseMetadata'][p['database']]['owner']
        clone=self.clone_for_migration(backup['path'],'offline-crm',uid,gid);runtime=self.root/'offline-runtime';runtime.mkdir(mode=0o755);runtime.chmod(0o755)
        for name in OFFLINE:
            data=(self.bundle/'tooling'/name).read_bytes();target=runtime/name;target.write_bytes(data);target.chmod(0o444)
        (runtime/'snapshot-proof.cjs').write_text(SNAPSHOT_PROOF);(runtime/'snapshot-proof.cjs').chmod(0o444)
        envfile=self.root/'crm-candidate.private.env';core.private_env(envfile,self.expected_env(p,'crm'))
        command=['docker','run','--rm','--network','none','--read-only','--user',f'{uid}:{gid}','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
            '--env-file',str(envfile),'-e','AVA_RELEASE_OFFLINE=1','-e','AVA_APP_ROOT=/app','-e','DB_PATH=/verify/crm.db',
            '--mount',f'type=bind,src={clone.parent},dst=/verify','--mount',f'type=bind,src={runtime},dst=/release,readonly','--entrypoint','node',p['images']['crm']]
        before=json.loads(self.run(command+['/release/snapshot-proof.cjs','snapshot'],timeout=120))
        startup=json.loads(self.run(command+['/release/startup-probe.cjs'],timeout=100))
        after=json.loads(self.run(command+['/release/snapshot-proof.cjs','integrity'],timeout=120))
        physical=compare_startup_snapshots(before,after)
        require(all(startup.get(k) is True for k in ('ok','realAppStart','customerRowsPreserved','schemaPreserved')),'ACTUAL_APP_START_FAILED')
        worker_env=self.root/'worker-before.private.env';core.private_env(worker_env,core.envmap(p['before']['worker']))
        worker_script=r'''const out=process.stdout.write.bind(process.stdout),exit=process.exit.bind(process);
process.stdout.write=()=>true;process.stderr.write=()=>true;for(const n of ['log','info','warn','error','debug'])console[n]=()=>{};
require('/release/migrations.cjs').prohibitActivity();const app=require('node:module').createRequire('/app/package.json');
app('./provisioning-worker');for(const name of JSON.parse(process.argv[1]))app('./'+name);
out(JSON.stringify({ok:true,workerStarted:false,networkEnabled:false})+'\n',()=>exit(0));'''
        worker=json.loads(self.run(['docker','run','--rm','--network','none','--read-only','--user',p['before']['worker']['Config']['User'],
            '--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--env-file',str(worker_env),
            '--mount',f'type=bind,src={runtime},dst=/release,readonly','--entrypoint','node',p['images']['worker'],
            '-e',worker_script,json.dumps(list(WORKER))],timeout=90))
        require(worker.get('ok') is True and worker.get('workerStarted') is False,'WORKER_OFFLINE_IMPORT_FAILED')
        engine_env=self.root/'engine-before.private.env';core.private_env(engine_env,core.envmap(p['before']['engine']))
        imports=r'''import socket,subprocess,asyncio,importlib,sys,json,logging
def denied(*a,**k):raise RuntimeError('OFFLINE_ACTIVITY_DENIED')
socket.socket.connect=denied;socket.socket.connect_ex=denied;socket.create_connection=denied;socket.getaddrinfo=denied
for n in ['Popen','run','call','check_call','check_output']:setattr(subprocess,n,denied)
asyncio.create_task=denied;asyncio.ensure_future=denied
logging.disable(logging.CRITICAL)
for name in json.loads(sys.argv[1]):importlib.import_module(name)
print(json.dumps({'ok':True,'providerStarted':False,'networkEnabled':False}))'''
        modules=[name[:-3].replace('/','.') for name in ENGINE]
        engine=json.loads(self.run(['docker','run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
            '--env-file',str(engine_env),'-e','PYTHONDONTWRITEBYTECODE=1','--entrypoint','python',p['images']['engine'],'-c',imports,json.dumps(modules)],timeout=90))
        require(engine.get('ok') is True and engine.get('providerStarted') is False,'ENGINE_OFFLINE_IMPORT_FAILED');self.db_guard(p)
        gate={'pass':True,'manifestSha256':self.manifest_sha,'images':p['images'],'actualAppStart':True,'allLogicalCrmRowsAndSchemaPreserved':True,
            'ftsIntegrityVerified':True,'physicalFtsShadowChanges':physical,'engineImports':engine,'workerImports':worker,'liveDatabaseMounted':False,'liveDdlExecuted':False,
            'environmentSha256':c.file_sha(envfile),'engineEnvironmentSha256':c.file_sha(engine_env),'workerEnvironmentSha256':c.file_sha(worker_env)}
        c.private_json(self.root/'offline-gate.private.json',gate);p['offlineGateSha256']=c.file_sha(self.root/'offline-gate.private.json')
        return gate
    def offline_guard(self,p):
        path=self.root/'offline-gate.private.json';require(path.is_file() and c.file_sha(path)==p.get('offlineGateSha256'),'OFFLINE_GATE_REQUIRED')
        g=json.loads(path.read_text());require(g.get('pass') is True and g.get('manifestSha256')==self.manifest_sha and g.get('images')==p['images']
            and g.get('liveDatabaseMounted') is False and g.get('liveDdlExecuted') is False
            and g.get('environmentSha256')==c.file_sha(self.root/'crm-candidate.private.env')
            and g.get('engineEnvironmentSha256')==c.file_sha(self.root/'engine-before.private.env')
            and g.get('workerEnvironmentSha256')==c.file_sha(self.root/'worker-before.private.env'),'OFFLINE_GATE_DRIFT')
    def prepare(self):
        require(not (self.root/'prepared.private.json').exists(),'ALREADY_PREPARED');before=self.rows()
        for role,row in before.items():require(row['Image']==IMAGES[role] and row['State']['Running'] and not row['State'].get('Paused'),'BASE_IMAGE_STATE_CHANGED')
        others=self.others();inputs=self.inputs(before);images={};trees={};excluded={};renders={};overrides={};expected={}
        for role in SELECTED:
            row=before[role];normalized_host_config(row['HostConfig']);require(len(row['Mounts'])==len({m['Destination'] for m in row['Mounts']}),'MOUNT_DESTINATION_COLLISION')
            excluded[role]=c.excluded_mounts(row);base=c.hashes(self.run,role,IMAGES[role],excluded[role],image=True)
            require(c.hashes(self.run,role,row['Id'],excluded[role])==base,'LIVE_IMAGE_SOURCE_DRIFT:'+role)
            for name,digest in self.m['services'][role]['preimages'].items():require(base.get(name)==digest,'EXACT_PREIMAGE_DRIFT:'+role)
            trees[role]=base;files=self.m['services'][role]['files'];expected[role]=c.expected_tree(base,files,role=='crm')
            directory=self.root/('build-'+role);require(not directory.exists(),'BUILD_EXISTS');copy_context(self.bundle/'payload'/role,directory/'overlay')
            for path in [directory,*directory.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
            user=row['Config'].get('User');require(isinstance(user,str) and re.fullmatch('[A-Za-z0-9_:.-]+',user),'BASE_USER_INVALID')
            tag='ava-product-journeys-base-'+role+':'+IMAGES[role][-16:];self.run(['docker','tag',IMAGES[role],tag])
            dockerfile='FROM '+tag+'\nUSER 0:0\n'+('RUN rm -rf /app/frontend/dist\n' if role=='crm' else '')+'COPY overlay/ /app/\nUSER '+user+'\n'
            (directory/'Dockerfile').write_text(dockerfile);tag='ava-product-journeys-'+role+':'+self.m['candidateCommit'][:12]+'-'+self.manifest_sha[:10]
            self.run(['docker','build','--network','none','--pull=false','-t',tag,str(directory)],timeout=600);images[role]=json.loads(self.run(['docker','image','inspect',tag]))[0]['Id']
            require(c.hashes(self.run,role,images[role],excluded[role],image=True)==expected[role],'UNSELECTED_SOURCE_BYTE_FENCE_FAILED:'+role)
            baseline=core.rendered(row);renders[role]=baseline
            require(core.mount_signature(baseline.get('volumes',[]))==core.mount_signature(row['Mounts'],live=True),'COMPOSE_MOUNT_DRIFT')
            require(all(core.envmap(row).get(k)==v for k,v in baseline.get('environment',{}).items()),'COMPOSE_ENV_DRIFT')
            overrides[role]={};service=row['Config']['Labels']['com.docker.compose.service']
            for phase,target in [('candidate',images[role]),('rollback',IMAGES[role])]:
                delta={'image':target}
                file=self.root/(role+'-'+phase+'.private.json');c.private_json(file,{'services':{service:delta}})
                wanted={**copy.deepcopy(baseline),'image':target}
                require(core.rendered(row,file)==wanted,'EXACT_COMPOSE_OVERRIDE_DRIFT');overrides[role][phase]=str(file)
        database=self.database(before);engine_dbs=self.engine_databases(before);metadata={str(path):self.metadata(Path(path)) for path in [database,*engine_dbs]}
        require(metadata[str(database)]['owner']==[1000,986,0o600],'DATABASE_OWNER_CHANGED')
        p={'manifestSha256':self.manifest_sha,'candidateCommit':self.m['candidateCommit'],'before':before,'images':images,'baseTrees':trees,'expectedTrees':expected,
            'excluded':excluded,'renders':renders,'overrides':overrides,'inputs':inputs,'otherContainers':others,'database':str(database),
            'databaseMetadata':metadata,'engineDatabases':engine_dbs}
        p['configuration']=self.prepare_configuration(before,images['engine'],inputs)
        self.input_guard(p);p['offlineGate']=self.offline(p);self.input_guard(p);c.private_json(self.root/'prepared.private.json',p)
        return {'phase':'prepared','candidateCommit':p['candidateCommit'],'images':images,'actualCopyAppStartPassed':True,'workerOfflineImportsPassed':True,'engineOfflineImportsPassed':True,'configurationStagedOnly':True,
            'candidateEnvironmentFile':str(self.root/'crm-candidate.private.env'),'liveContainersChanged':False}
    def guard_before(self,p):
        self.input_guard(p);require(c.file_sha(CONFIG_PATH)==CONFIG_SHA,'BEFORE_CONFIGURATION_REQUIRED')
        for role in SELECTED:
            row=self.inspect(NAMES[role]);old=p['before'][role]
            require(row['Id']==old['Id'] and row['Image']==IMAGES[role] and row['State']['Running'] and row.get('RestartCount')==old.get('RestartCount'),'BASE_CONTAINER_CHANGED:'+role)
            require(core.envmap(row)==core.envmap(old) and row['Mounts']==old['Mounts'],'LIVE_RUNTIME_CHANGED:'+role);self.host_guard(role,old['HostConfig'],row['HostConfig'])
            require(c.hashes(self.run,role,row['Id'],p['excluded'][role])==p['baseTrees'][role],'LIVE_SOURCE_CHANGED:'+role)
    def runtime_guard(self,p,role,row,rollback=False):
        old=p['before'][role]
        require(core.envmap(row)==self.expected_env(p,role,rollback),'ENV_CHANGED:'+role)
        require(len(row['Mounts'])==len({m['Destination'] for m in row['Mounts']}),'MOUNT_DESTINATION_COLLISION')
        require(core.mount_signature(row['Mounts'],live=True)==core.mount_signature(old['Mounts'],live=True),'MOUNTS_CHANGED:'+role);self.host_guard(role,old['HostConfig'],row['HostConfig'])
        require(set(row['NetworkSettings']['Networks'])==set(old['NetworkSettings']['Networks']),'NETWORK_CHANGED:'+role)
        for key in ('User','Entrypoint','Cmd','WorkingDir','Healthcheck','StopSignal','StopTimeout'):require(row['Config'].get(key)==old['Config'].get(key),'PROCESS_CHANGED:'+role+':'+key)
    def check(self,p,role,rollback=False):
        row=self.inspect(NAMES[role]);old=p['before'][role];target=IMAGES[role] if rollback else p['images'][role]
        restarts=old.get('RestartCount') if rollback and row['Id']==old['Id'] else 0
        require(row['Image']==target and row['State']['Running'] and not row['State'].get('Paused') and row.get('RestartCount')==restarts,'IMAGE_STATE_INVALID:'+role)
        self.runtime_guard(p,role,row,rollback)
        return row
    def up(self,p,role,rollback=False):
        require(role in SELECTED,'ROLE_MUTATION_FORBIDDEN')
        self.input_guard(p,recovery=rollback);row=p['before'][role];target=IMAGES[role] if rollback else p['images'][role];override=p['overrides'][role]['rollback' if rollback else 'candidate']
        wanted={**copy.deepcopy(p['renders'][role]),'image':target}
        require(core.rendered(row,override)==wanted,'RENDER_CHANGED:'+role)
        if role=='engine':self.switch_configuration(p,rollback)
        command,cwd,service=core.compose(row,override);self.run(command+['up','-d','--no-deps','--pull','never','--force-recreate',service],cwd=cwd,timeout=150)
        deadline=time.monotonic()+100
        while time.monotonic()<deadline:
            current=self.inspect(NAMES[role]);require(current.get('RestartCount')==0,'SERVICE_RESTARTED:'+role)
            self.check(p,role,rollback)  # Exact runtime violations never become readiness retries.
            try:
                if role=='crm':require(current['State'].get('Health',{}).get('Status')=='healthy','CRM_UNHEALTHY')
                self.ready(role);return
            except Exception as error:
                if not transient_readiness(error):raise
                c.private_json(self.root/(role+'-readiness-last.private.json'),failure_details(error))
            time.sleep(2)
        raise RuntimeError('HEALTH_TIMEOUT:'+role)
    def verify(self,rollback=False):
        p=self.load();self.input_guard(p);require(c.file_sha(CONFIG_PATH)==(CONFIG_SHA if rollback else p['configuration']['afterSha256']),'INSTALLED_CONFIGURATION_DRIFT');images={}
        for role in SELECTED:
            row=self.check(p,role,rollback);self.ready(role);wanted=p['baseTrees'][role] if rollback else p['expectedTrees'][role]
            require(c.hashes(self.run,role,row['Id'],p['excluded'][role])==wanted,'RUNNING_SOURCE_FENCE_FAILED:'+role);images[role]=row['Image']
        with urlopen('https://wh.meludtech.tech/api/health',timeout=15) as r:require(r.status==200 and json.load(r).get('status')=='ok','PUBLIC_API_FAILED')
        wanted=p['baseTrees']['crm'] if rollback else p['expectedTrees']['crm']
        with urlopen('https://wh.meludtech.tech/',timeout=15) as r:require(r.status==200 and c.sha(r.read(2*1024*1024))==wanted['frontend/dist/index.html'],'PUBLIC_INDEX_CHANGED')
        return {'candidateCommit':p['candidateCommit'],'images':images,'rollback':rollback,'databaseRetained':True,'sourceBytesVerified':True,'otherContainersPreserved':True,'customerAcceptance':'NOT_TESTED'}
    def recover(self,p):
        failures={}
        for role in SELECTED:
            try:
                try:row=self.inspect(NAMES[role])
                except Exception:row=None
                if row:
                    require(row['Image'] in (IMAGES[role],p['images'][role]),'ROLLBACK_IMAGE_DRIFT:'+role)
                    baseline=row['Image']==IMAGES[role];self.runtime_guard(p,role,row,baseline)
                    if row['State']['Running']:
                        wanted=p['baseTrees'][role] if baseline else p['expectedTrees'][role]
                        require(c.hashes(self.run,role,row['Id'],p['excluded'][role])==wanted,'ROLLBACK_LIVE_SOURCE_DRIFT:'+role)
                if row and row['Image']==IMAGES[role] and row['State']['Running'] and (role!='engine' or c.file_sha(CONFIG_PATH)==CONFIG_SHA):self.check(p,role,True);self.ready(role)
                else:self.up(p,role,True)
            except Exception as error:failures[role]=safe_error(error,'RECOVERY_FAILED')
        # A later role's recreation must not hide a previously restored role
        # changing again. Final strict readback is followed by full verify().
        readback={}
        for role in SELECTED:
            try:self.check(p,role,True)
            except Exception as error:
                readback[role]=safe_error(error,'RECOVERY_READBACK_FAILED');failures.setdefault(role,readback[role])
        c.private_json(self.root/'recovery.private.json',{'failures':failures,'finalReadbackFailures':readback,'databaseRestored':False,'allPriorImagesRestored':not readback})
        require(not failures and not readback,'CODE_ROLLBACK_REQUIRES_ATTENTION')
    def rollback(self):
        p=self.load();self.input_guard(p,recovery=True);self.recover(p);self.db_guard(p);result=self.verify(True);c.private_json(self.root/'rolled-back.private.json',result);return result
    def apply(self):
        p=self.load();require(not (self.root/'apply-started.private.json').exists(),'APPLY_ALREADY_STARTED');self.offline_guard(p);self.guard_before(p)
        backup=self.crm_backup(Path(p['database']),'apply-crm-backup',IMAGES['crm'])
        ledgers={str(i):self.engine_backup(Path(path),'apply-engine-backup-'+str(i),IMAGES['engine']) for i,path in enumerate(p['engineDatabases'])}
        c.private_json(self.root/'apply-backups.private.json',{'crm':backup,'engine':ledgers,'configuration':p['configuration'],'databaseRestored':False});self.guard_before(p);core.idle()
        c.private_json(self.root/'apply-started.private.json',{'candidateCommit':p['candidateCommit']})
        try:
            for role in SELECTED:self.up(p,role)
            result=self.verify();c.private_json(self.root/'applied.private.json',result);return {'phase':'applied',**result}
        except Exception as error:
            c.private_json(self.root/'activation-failure.private.json',failure_details(error))
            try:self.rollback()
            except Exception:raise RuntimeError('APPLY_FAILED_CODE_RECOVERY_REQUIRES_ATTENTION_DATABASE_RETAINED') from None
            raise RuntimeError('APPLY_FAILED_PREVIOUS_CODE_RESTORED_DATABASE_RETAINED') from None

def main():
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['pack','prepare','apply','verify','rollback'])
    for name in ('repo','frontend-dist','frontend-receipt','output','root','bundle'):p.add_argument('--'+name,type=Path)
    p.add_argument('--candidate');p.add_argument('--manifest-sha256');args=p.parse_args()
    if args.action=='pack':
        require(all(getattr(args,n) is not None for n in ('repo','candidate','frontend_dist','frontend_receipt','output')),'PACK_ARGUMENTS_REQUIRED');result=pack(args)
    else:
        require(args.root and args.bundle and args.manifest_sha256,'HOST_ARGUMENTS_REQUIRED')
        with Path('/var/lock/ava-customer-path-release.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise RuntimeError('CROSS_SERVICE_RELEASE_ALREADY_RUNNING') from None
            result=getattr(Release(args),args.action)()
    print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'phase':'failed','code':safe_error(error,'PRODUCT_JOURNEYS_RELEASE_FAILED')}));raise SystemExit(1)
