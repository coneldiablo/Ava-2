#!/usr/bin/env python3
"""Generic root-operated native knowledge catch-up and retrieval readback.

No LLM call, provider/model creation, shared credential, or readiness shortcut.
The default is a read-only plan. --run provisions the two existing CRM-derived
native identities, reconciles current parsed sources, checks actual runtime
retrieval, and records metadata proof. Runtime admission remains worker-only.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import uuid
from urllib.parse import urlparse

from module_deployment_helper import owned_path, private_json, DeploymentError
from onyx_native_verifier import container_for, require
import onyx_native_index_probe as index_probe


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


sync = load("ava_bootstrap_sync", "reconcile-onyx-native-knowledge.py")
projection = load("ava_bootstrap_projection", "project-onyx-native-knowledge.py")
FIELDS = {"businessId", "deploymentId", "nativeScope", "revision", "ownerUserId", "modelConfigurationId", "providerId", "providerApiBase", "modelName"}


def load_config(path):
    _, value = private_json(path)
    require(set(value) == FIELDS, "DEPLOYMENT_NATIVE_VERIFIER_CONFIGURATION_REQUIRED")
    require(all(type(value[key]) is int and value[key] > 0 for key in ("businessId", "revision", "modelConfigurationId", "providerId")))
    require(str(uuid.UUID(value["deploymentId"])) == value["deploymentId"] and str(uuid.UUID(value["ownerUserId"])) == value["ownerUserId"])
    require(value["nativeScope"] == "ava_" + value["deploymentId"].replace("-", ""))
    # Onyx receives an own-deployment opaque AVA gateway credential, never a
    # direct provider key or another tenant's credential. The gateway preserves
    # the approved upstream AITunnel configuration independently.
    base = urlparse(value["providerApiBase"])
    require(base.scheme == "https" and base.hostname and not base.username and not base.password
            and not base.query and not base.fragment and base.path == "/api/integrations/onyx/llm"
            and value["modelName"] == f"ava-hotel-{value['businessId']}")
    return value


def owner_from_crm(db_path, config):
    sync.deployment_fence(db_path, config)
    with sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        row = db.execute("SELECT u.subject FROM ava_users u JOIN ava_business_memberships m ON m.userId=u.id "
            "WHERE u.id=? AND u.enabled=1 AND m.businessId=? AND m.enabled=1 AND m.role='hotel_owner'",
            (config["ownerUserId"], config["businessId"])).fetchone()
    require(row is not None and isinstance(row[0], str) and row[0], "DEPLOYMENT_NATIVE_PROOF_INCOMPLETE")
    return row[0]


def current_binding(db_path, config):
    with sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT a.id AS adapterId,a.revision AS adapterRevision,a.integrationId,a.integrationRevision,a.deploymentRevision,a.peerSecretHash "
            "FROM ava_module_adapters a JOIN onyx_tenant_links t ON t.id=a.integrationId AND t.business_id=a.businessId "
            "WHERE a.businessId=? AND a.module='onyx' AND a.enabled=1 AND a.deploymentId=? AND a.deploymentRevision=? "
            "AND a.nativeScope=? AND a.attachmentMode='existing_workspace_ui' AND a.attachmentModeV2='isolated_workspace_ui' "
            "AND t.revision=a.integrationRevision AND t.status!='DISABLED' AND t.onyx_tenant_id=?",
            (config["businessId"], config["deploymentId"], config["revision"], config["nativeScope"], config["nativeScope"])).fetchone()
    require(row is not None)
    return dict(row)


def model_credential_hash(db_path, config):
    with sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        row = db.execute("SELECT token_hash FROM onyx_llm_deployment_credentials WHERE deployment_id=? AND business_id=? AND deployment_revision=? AND enabled=1",
            (config["deploymentId"], config["businessId"], config["revision"])).fetchone()
    require(row is not None and isinstance(row[0], str) and len(row[0]) == 64)
    return row[0]


def execute(container, code, payload, timeout=120):
    source = "import json\np=json.loads(" + repr(json.dumps(payload, separators=(",", ":"))) + ")\n" + code
    result = subprocess.run(["docker", "exec", "-i", container, "python", "-B", "-"], input=source, text=True,
        capture_output=True, timeout=timeout, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "DOCKER_HOST": "unix:///var/run/docker.sock"})
    # Native output/errors can contain text and credentials. Validate a bounded
    # last JSON line in memory, and never relay raw stdout/stderr on failure.
    require(result.returncode == 0 and len(result.stdout) <= 131072)
    value = json.loads(result.stdout.strip().splitlines()[-1])
    require(isinstance(value, dict))
    return value


MODEL = r'''
import hashlib
from onyx.db.engine.sql_engine import SqlEngine,get_session_with_current_tenant
from onyx.db.models import ModelConfiguration,LLMProvider
SqlEngine.init_engine(pool_size=1,max_overflow=0)
with get_session_with_current_tenant() as db:
 model=db.get(ModelConfiguration,p['modelConfigurationId']);provider=db.get(LLMProvider,p['providerId'])
 token=provider.api_key if provider else None
 if hasattr(token,'get_value'):token=token.get_value(apply_mask=False)
 ready=bool(model and provider and model.llm_provider_id==provider.id and model.name==p['modelName'] and model.is_visible
  and provider.api_base==p['providerApiBase'] and provider.provider=='openai' and isinstance(token,str)
  and hashlib.sha256(token.encode()).hexdigest()==p['gatewayTokenHash'])
print(json.dumps({'approvedModelReady':ready}))
'''

PROVISION = r'''
import os,urllib.request
from onyx.ava_auth.core import read_secret
key=read_secret(os.environ['AVA_AUTH_WORKER_KEY_FILE']).decode('ascii')
results=[]
for user in p['users']:
 req=urllib.request.Request('http://127.0.0.1:4011/v1/provision',data=json.dumps({**p['scope'],**user}).encode(),
  headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=20) as response: v=json.load(response)
 expected={**p['scope'],**user}
 assert response.status==200 and all(v.get(k)==x for k,x in expected.items()) and v.get('state')=='active'
 results.append({'userId':v['userId'],'nativeUserId':v['nativeUserId']})
print(json.dumps({'users':results}))
'''

KNOWLEDGE_REQUEST = r'''
import os,urllib.request
from onyx.ava_auth.core import read_secret
key=read_secret(os.environ['AVA_AUTH_WORKER_KEY_FILE']).decode('ascii')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
req=urllib.request.Request('http://127.0.0.1:4013'+p['path'],data=json.dumps(p['body']).encode(),method='POST',
 headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
with opener.open(req,timeout=120) as response:
 assert response.status==200
 print(json.dumps(json.load(response)))
'''

METADATA = r'''
from onyx.db.engine.sql_engine import SqlEngine,get_session_with_current_tenant
from onyx.db.models import Document
SqlEngine.init_engine(pool_size=1,max_overflow=0)
with get_session_with_current_tenant() as db:
 for item in p['documents']:
  doc=db.get(Document,item['native_id']);assert doc and doc.from_ingestion_api and doc.chunk_count>0
  metadata=doc.doc_metadata or {}
  def single(value):return value[0] if isinstance(value,list) and len(value)==1 else value
  assert single(metadata.get('business_id'))==str(p['businessId'])
  assert single(metadata.get('ava_entity_type'))=='knowledge'
  assert single(metadata.get('ava_source_id'))==item['source_id']
  assert single(metadata.get('ava_content_hash'))==item['content_hash']
print(json.dumps({'currentSourceMetadataVerified':True}))
'''

# Keep the read-only probe outside the recovered image source. The immutable
# operator release supplies it over stdin to the exact labelled API container.
INDEX_RETRIEVAL = "exec(compile(" + repr(Path(index_probe.__file__).read_text()) + ",'<ava-index-probe>','exec'))\nprint(json.dumps(run_probe(p)))\n"


def validate_index_readback(value, documents, business_id):
    expected = {f"ava:{business_id}:knowledge:{item['source_id']}": {
        "onyx_document_id": item["native_id"], "source_id": item["source_id"], "content_hash": item["content_hash"]}
        for item in documents}
    require(value == {"indexReadinessVerified": True, "indexProbeMethod": "default_document_index_random_acl_v1",
                      "indexedDocuments": expected})
    return value

RETRIEVAL = r'''
import os,time,uuid,urllib.request,urllib.error,urllib.parse
from onyx.ava_auth.core import read_secret
key=read_secret(os.environ['AVA_AUTH_GATEWAY_KEY_FILE']).decode('ascii')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
def request(path,body=None,headers=None,peer=False):
 url=('http://127.0.0.1:4011' if peer else 'http://api:8080')+path
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),
  headers={'Content-Type':'application/json',**(headers or {})},method='GET' if body is None else 'POST')
 try: response=opener.open(req,timeout=20)
 except urllib.error.HTTPError as error:response=error
 with response:
  raw=response.read(2*1024*1024+1);assert len(raw)<=2*1024*1024
  try:value=json.loads(raw)
  except ValueError:value={}
  return response.status,value
user={**p['scope'],**p['runtime']};binding=str(uuid.uuid4());created=False;revoked=False
session_body={**user,'bindingId':binding,'expiresAt':int(time.time()*1000)+120000}
try:
 status,session=request('/v1/sessions/create',session_body,{'Authorization':'Bearer '+key},peer=True)
 assert status==200 and all(session.get(k)==session_body[k] for k in ('businessId','deploymentId','nativeScope','userId','nativeUserId','bindingId'))
 created=True;headers={'X-Ava-Native-Peer':key,'X-Ava-Native-Binding':binding,'Cookie':session['nativeCookie']}
 status,me=request('/me',headers=headers);assert status==200 and me.get('id')==user['nativeUserId']
 status,persona=request('/persona/'+str(p['binding']['persona_id']),headers=headers)
 assert status==200 and persona.get('is_public') is False
 assert {item['name'] for item in persona.get('document_sets',[])}=={p['binding']['document_set_name']}
 for item in p['documents']:
  path='/document/chunk-info?'+urllib.parse.urlencode({'document_id':item['native_id'],'chunk_id':0})
  status,chunk=request(path,headers=headers);assert status==200 and isinstance(chunk.get('content'),str) and chunk['content'].strip()
 # The peer cannot mint a session outside this organization or revision.
 for wrong in ({**session_body,'businessId':user['businessId']+1},{**session_body,'revision':user['revision']+1}):
  assert request('/v1/sessions/create',wrong,{'Authorization':'Bearer '+key},peer=True)[0]==403
 assert request('/manage/admin/users',headers=headers)[0]==403
 status,receipt=request('/v1/sessions/revoke',{'bindingId':binding},{'Authorization':'Bearer '+key},peer=True)
 revoked=status==200 and receipt.get('nativeSessionAbsent') is True;assert revoked
 assert request('/me',headers=headers)[0]==403
 print(json.dumps({'ownAccess':True,'foreignAccessDenied':True,'cleanupVerified':True}))
finally:
 if created and not revoked:
  try:request('/v1/sessions/revoke',{'bindingId':binding},{'Authorization':'Bearer '+key},peer=True)
  except Exception:pass
'''


def prepare(*, config_path, crm_db, recipes, run=False):
    config = load_config(config_path)
    owner_subject = owner_from_crm(crm_db, config)
    root = recipes / config["deploymentId"]
    _, recipe = private_json(root / "recipe.json"); _, compose = private_json(root / "compose.json")
    require(recipe["businessId"] == config["businessId"] and recipe["revision"] == config["revision"]
            and recipe["namespace"] == config["nativeScope"] and recipe["deploymentId"] == config["deploymentId"])
    require("knowledge-api" in compose["services"], "DEPLOYMENT_KNOWLEDGE_OVERLAY_REQUIRED")
    snapshot = sync.read_canonical_documents(crm_db, config["businessId"])
    require(bool(snapshot), "DEPLOYMENT_NATIVE_PROOF_INCOMPLETE")
    if not run:
        return {"businessId": config["businessId"], "sources": len(snapshot), "dryRun": True, "sourceKnowledgeVerified": False}
    scope = {key: config[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")}
    binding_revision = current_binding(crm_db, config)
    api, auth, knowledge = [container_for(scope, service, compose["services"][service]["image"]) for service in ("api", "auth", "knowledge-api")]
    gateway_hash = model_credential_hash(crm_db, config)
    require(execute(api, MODEL, {**config, "gatewayTokenHash": gateway_hash}).get("approvedModelReady") is True)
    runtime_id = str(uuid.uuid5(uuid.UUID(config["deploymentId"]), f"ava-runtime-principal:{config['businessId']}"))
    native_id = str(uuid.uuid5(uuid.UUID(config["deploymentId"]), "ava-user:" + runtime_id))
    users = [{"userId": config["ownerUserId"], "subject": owner_subject, "role": "hotel_owner"},
             {"userId": runtime_id, "subject": f"ava-onyx-runtime:{config['businessId']}", "role": "manager"}]
    execute(auth, PROVISION, {"scope": scope, "users": users})
    require(owner_from_crm(crm_db, config) == owner_subject)
    payload = {**scope, "ownerUserId": config["ownerUserId"], "runtimeUserId": runtime_id, "modelConfigurationId": config["modelConfigurationId"]}
    binding = execute(knowledge, KNOWLEDGE_REQUEST, {"path": "/v1/knowledge/bootstrap", "body": payload})
    reconcile_config = {**scope, "ownerUserId": config["ownerUserId"], "runtimeUserId": runtime_id,
                        **{key: binding.get(source) for key, source in (("ownerCcPairId", "owner_cc_pair_id"), ("runtimeCcPairId", "runtime_cc_pair_id"), ("documentSetId", "document_set_id"))}}
    output = root / "config"
    owned_path(output, directory=True)
    receipt = {**scope, "binding": binding, "sourceKnowledgeVerified": False}
    sync.write_checkpoint(output / "knowledge-reconcile.json", reconcile_config)
    sync.load_config(output / "knowledge-reconcile.json")
    sync.write_checkpoint(output / "knowledge-bootstrap-receipt.json", receipt)
    _, keys = private_json(root / "secrets.json")
    key_path = output / "knowledge-reconcile.key"
    owned_path(output, directory=True)
    # Host copy stays root-only for the periodic reconciler; native containers
    # retain their original independently mounted 0440 writer credential.
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(os.fstat(fd).st_uid == 0 and os.fstat(fd).st_mode & 0o077 == 0)
        os.ftruncate(fd, 0); os.write(fd, keys["workerPeer"].encode()); os.fsync(fd)
    finally: os.close(fd)
    def native_request(_url, _key, path, body): return execute(knowledge, KNOWLEDGE_REQUEST, {"path": path, "body": body}, timeout=180)
    sync._request = native_request
    checkpoint_path = output / "knowledge-reconcile-checkpoint.json"
    result = sync.reconcile(config_path=output / "knowledge-reconcile.json", crm_db=crm_db,
        checkpoint_path=checkpoint_path, api_url="http://knowledge-api", worker_key_path=key_path)
    require(sync.read_canonical_documents(crm_db, config["businessId"]) == snapshot)
    checkpoint = sync.read_checkpoint(checkpoint_path, reconcile_config)
    documents = [{"source_id": doc["source_id"], "native_id": projection.quote(doc_id, safe=""), "content_hash": doc["content_hash"]} for doc_id, doc in snapshot.items()]
    require(execute(api, METADATA, {"businessId": config["businessId"], "documents": documents}).get("currentSourceMetadataVerified") is True)
    runtime = {**users[1], "nativeUserId": native_id}
    index_readback = validate_index_readback(execute(api, INDEX_RETRIEVAL,
        {"scope": scope, "runtime": runtime, "binding": binding, "documents": documents}, timeout=180), documents, config["businessId"])
    index_proof = {"scope": scope, "checkedAt": int(time.time() * 1000), **index_readback}
    readback = execute(auth, RETRIEVAL, {"scope": scope, "runtime": runtime, "binding": binding, "documents": documents}, timeout=180)
    require(all(readback.get(key) is True for key in ("ownAccess", "foreignAccessDenied", "cleanupVerified")))
    readback = {**readback, **index_readback, "sourceKnowledgeVerified": True}
    require(owner_from_crm(crm_db, config) == owner_subject and current_binding(crm_db, config) == binding_revision)
    require(model_credential_hash(crm_db, config) == gateway_hash
            and execute(api, MODEL, {**config, "gatewayTokenHash": gateway_hash}).get("approvedModelReady") is True)
    require(load_config(config_path) == config and sync.read_canonical_documents(crm_db, config["businessId"]) == snapshot)
    sync.write_checkpoint(output / "knowledge-index-readback.json", index_proof)
    with sqlite3.connect(crm_db.resolve().as_uri() + "?mode=rw", uri=True, isolation_level=None) as db:
        projection.project(db, reconcile_config, receipt, checkpoint, index_readback=index_proof)
    proof = {**scope, **binding_revision, "servicePrincipalId": runtime_id, "subject": users[1]["subject"], "nativeUserId": native_id,
             **readback, "checkedAt": index_proof["checkedAt"], "documents": checkpoint["documents"]}
    sync.write_checkpoint(output / "knowledge-runtime-readback.json", proof)
    return {"businessId": config["businessId"], "sources": len(snapshot), "dryRun": False, **result, **readback,
            "searchabilityVerified": True, "runtimeAdmitted": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    require(os.geteuid() == 0)
    result = prepare(config_path=Path(os.environ["AVA_ONYX_BOOTSTRAP_CONFIG"]), crm_db=Path(os.environ["AVA_CRM_DB_PATH"]),
                     recipes=Path(os.environ["AVA_ONYX_RECIPES_DIRECTORY"]), run=args.run)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try: main()
    except (DeploymentError, sync.ReconcileError, projection.ProjectionError, KeyError, OSError, ValueError, IndexError, sqlite3.Error, subprocess.SubprocessError):
        raise SystemExit("ONYX_NATIVE_KNOWLEDGE_BOOTSTRAP_FAILED") from None
