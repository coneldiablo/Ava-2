#!/usr/bin/env python3
"""Read-only reciprocal storage-ACL proof for two fixed AVA Onyx contours.

This is intentionally narrower than a document lifecycle or browser proof.
It verifies that each already-running API process can access only its own
OpenSearch index and MinIO bucket, rejects the other contour's *named*
resources on its local private endpoint, and cannot enumerate runtime storage.
It does not establish cross-server reachability. Credentials never leave the
API processes and the host receives only bounded IDs and boolean checks.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Any


LIVE_ROOT = Path("/opt/ava-deploy/onyx-customer-entry-1")
LIVE_OPERATOR_MANIFEST = LIVE_ROOT / "operator.json"
LIVE_CATALOGUE = LIVE_ROOT / "catalogue.json"
QA_ROOT = Path("/opt/ava-acceptance/ecosystem-20260914/onyx-recipe-qa-r9")
QA_MANIFEST = QA_ROOT / "manifest.json"
QA_CATALOGUE = QA_ROOT / "catalogue.json"
MAX_MANIFEST = 8192
MAX_DOCKER_OUTPUT = 65536
MAX_PROBE_OUTPUT = 16384
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
NAMESPACE = re.compile(r"ava_[0-9a-f]{32}\Z")
IMAGE = re.compile(r"(?:[^\s@]+@)?sha256:[0-9a-f]{64}\Z")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
PINNED_ONYX_SOURCE = "a1b9e02eb65cc114c65381cbef5e555e1753ed0a"

SCOPE_KEYS = frozenset(("businessId", "deploymentId", "nativeScope", "revision"))
OPERATOR_KEYS = frozenset(("schemaVersion", "kind", *SCOPE_KEYS, "principal"))
QA_MANIFEST_KEYS = frozenset(("qa_only", "buyer_acceptance", "rag_acceptance", "row", "payload"))
PROBE_CHECKS = frozenset((
    "runtime_scope_exact", "native_overlay_pinned", "namespace_storage_config_exact", "search_runtime_identity",
    "search_own_scope_available", "search_foreign_scope_denied", "search_admin_denied",
    "bucket_own_scope_available", "bucket_foreign_scope_denied", "bucket_global_list_scoped",
))
RECEIPT_CHECKS = frozenset(("live_container_binding", "qa_container_binding",
                            "live_runtime_acl", "qa_runtime_acl"))
RECEIPT_KEYS = frozenset(("schema_version", "ok", "storage_acl_only", "browser_storage_verified",
                          "live", "qa", "checks", "limitation"))


class VerificationError(Exception):
    pass


def _uuid(value: Any) -> str:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise VerificationError()
    return value


def _scope(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != SCOPE_KEYS:
        raise VerificationError()
    if type(value["businessId"]) is not int or value["businessId"] < 1:
        raise VerificationError()
    if type(value["revision"]) is not int or value["revision"] < 1:
        raise VerificationError()
    _uuid(value["deploymentId"])
    if not isinstance(value["nativeScope"], str) or not NAMESPACE.fullmatch(value["nativeScope"]):
        raise VerificationError()
    if value["nativeScope"] != "ava_" + value["deploymentId"].replace("-", ""):
        raise VerificationError()
    return dict(value)


def _private_json(path: Path, root: Path) -> dict[str, Any]:
    """Read only the two root-owned fixed manifests; paths are never caller input."""
    try:
        relative = path.relative_to(root)
        if relative.parts not in (("operator.json",), ("manifest.json",), ("catalogue.json",)):
            raise VerificationError()
        for item in (root, path):
            info = item.lstat()
            if info.st_uid != 0 or info.st_mode & 0o022 or item.is_symlink():
                raise VerificationError()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except (OSError, ValueError):
        raise VerificationError() from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > MAX_MANIFEST:
            raise VerificationError()
        raw = os.read(fd, MAX_MANIFEST + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_MANIFEST:
        raise VerificationError()
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise VerificationError() from None
    if not isinstance(value, dict):
        raise VerificationError()
    return value


def live_scope(manifest: dict[str, Any]) -> dict[str, Any]:
    if (set(manifest) != OPERATOR_KEYS or manifest.get("schemaVersion") != 1
            or manifest.get("kind") != "ava_onyx_customer_entry_operator"
            or not isinstance(manifest.get("principal"), dict)):
        raise VerificationError()
    return _scope({key: manifest[key] for key in SCOPE_KEYS})


def qa_scope(manifest: dict[str, Any]) -> dict[str, Any]:
    if (set(manifest) != QA_MANIFEST_KEYS or manifest.get("qa_only") is not True
            or manifest.get("buyer_acceptance") is not False or manifest.get("rag_acceptance") is not False):
        raise VerificationError()
    row = manifest.get("row")
    if not isinstance(row, dict):
        raise VerificationError()
    scope = _scope({"businessId": row.get("businessId"), "deploymentId": row.get("id"),
                    "nativeScope": row.get("namespace"), "revision": row.get("revision")})
    if (row.get("module") != "onyx" or row.get("sourceCommit") != PINNED_ONYX_SOURCE
            or scope["businessId"] not in (911001, 911002)):
        raise VerificationError()
    return scope


def backend_image(catalogue: dict[str, Any]) -> str:
    """Return the root-owned, digest-pinned backend image and nothing else."""
    image = catalogue.get("backendImage") if isinstance(catalogue, dict) else None
    if not isinstance(image, str) or not IMAGE.fullmatch(image):
        raise VerificationError()
    return image


def _run(command: list[str], *, input_data: str | None = None, limit: int) -> str:
    try:
        result = subprocess.run(command, input=input_data, text=True, capture_output=True, timeout=75,
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/var/empty",
                                     "DOCKER_HOST": "unix:///var/run/docker.sock", "COMPOSE_DISABLE_ENV_FILE": "true"})
    except (OSError, subprocess.SubprocessError):
        raise VerificationError() from None
    # stderr and raw process output can contain credentials; never relay either.
    if result.returncode or len(result.stdout) > limit:
        raise VerificationError()
    return result.stdout


# Docker's format expression selects only safe container metadata.  In
# particular it never serializes Config.Env, mounts, command arguments, or
# credentials back to the host verifier.
DOCKER_FORMAT = ('{"id":{{json .Id}},"image_id":{{json .Image}},"image":{{json .Config.Image}},'
                 '"deployment":{{json (index .Config.Labels "tech.melud.ava.deployment")}},'
                 '"business":{{json (index .Config.Labels "tech.melud.ava.business")}},'
                 '"revision":{{json (index .Config.Labels "tech.melud.ava.revision")}},'
                 '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                 '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                 '"running":{{json .State.Running}},"health":{{json .State.Health.Status}}}')


def api_container(scope: dict[str, Any], expected_image: str) -> dict[str, str]:
    ids = _run(["docker", "ps", "-aq", "--no-trunc", "--filter",
                "label=tech.melud.ava.deployment=" + scope["deploymentId"], "--filter",
                "label=com.docker.compose.service=api"], limit=MAX_DOCKER_OUTPUT).split()
    if len(ids) != 1 or any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in ids):
        raise VerificationError()
    output = _run(["docker", "inspect", "--format", DOCKER_FORMAT, *ids], limit=MAX_DOCKER_OUTPUT)
    containers = []
    try:
        for line in output.splitlines():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise VerificationError()
            containers.append(value)
    except (ValueError, TypeError):
        raise VerificationError() from None
    expected = {"deployment": scope["deploymentId"], "business": str(scope["businessId"]),
                "revision": str(scope["revision"]), "project": scope["nativeScope"]}
    for item in containers:
        if any(item.get(key) != value for key, value in expected.items()):
            raise VerificationError()
        if (item.get("service") != "api" or not isinstance(item.get("id"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", item["id"])
                or item.get("image") != expected_image or not isinstance(item.get("image_id"), str)
                or item["image_id"] != expected_image.split("@")[-1] or not IMAGE_ID.fullmatch(item["image_id"])
                or item.get("running") is not True):
            raise VerificationError()
    if len(containers) != 1 or containers[0].get("health") != "healthy":
        raise VerificationError()
    return {"id": containers[0]["id"], "image_id": containers[0]["image_id"]}


PROBE = r'''import base64,json,os,ssl,sys,urllib.error,urllib.request
payload=json.loads(__PAYLOAD__)
def failure(): raise SystemExit(71)
scope=payload['scope']; foreign=payload['foreign']
required={'AVA_BUSINESS_ID':str(scope['businessId']),'AVA_DEPLOYMENT_ID':scope['deploymentId'],
 'AVA_DEPLOYMENT_NAMESPACE':scope['nativeScope'],'AVA_DEPLOYMENT_REVISION':str(scope['revision'])}
if any(os.environ.get(k)!=v for k,v in required.items()): failure()
from onyx.ava_namespace import bucket_name,validate_index_name,validate_runtime_storage
try: validate_runtime_storage()
except Exception: failure()
try:
 overlay=json.load(open('/app/AVA_EXTENSION_MANIFEST.json',encoding='utf-8'))
 if not isinstance(overlay,dict) or overlay.get('upstream_commit')!=__PINNED__ or not isinstance(overlay.get('changes'),dict) or not overlay['changes']: failure()
except Exception: failure()
own_bucket=bucket_name()
if own_bucket!=scope['nativeScope'].replace('_','-')+'-files': failure()
try:
 import psycopg2
 db=psycopg2.connect(host=os.environ['POSTGRES_HOST'],port=os.environ['POSTGRES_PORT'],dbname=os.environ['POSTGRES_DB'],user=os.environ['POSTGRES_USER'],password=os.environ['POSTGRES_PASSWORD'],connect_timeout=5,options='-c default_transaction_read_only=on')
 db.set_session(readonly=True,autocommit=True)
 cur=db.cursor(); cur.execute("SELECT index_name FROM search_settings WHERE status='PRESENT' ORDER BY id DESC LIMIT 1")
 row=cur.fetchone(); cur.close(); db.close()
 if not isinstance(row,tuple) or len(row)!=1 or not isinstance(row[0],str): failure()
 own_index=validate_index_name(row[0])
except Exception: failure()
ctx=ssl.create_default_context(cafile=os.environ.get('OPENSEARCH_CA_CERTS',''))
user=os.environ.get('OPENSEARCH_ADMIN_USERNAME',''); password=os.environ.get('OPENSEARCH_ADMIN_PASSWORD','')
if user!=scope['nativeScope']+'_runtime' or not password: failure()
def search(method,path):
 token=base64.b64encode((user+':'+password).encode()).decode()
 req=urllib.request.Request('https://search:9200'+path,headers={'Authorization':'Basic '+token},method=method)
 try:
  class NoRedirect(urllib.request.HTTPRedirectHandler):
   def redirect_request(self,*args): return None
  opener=urllib.request.build_opener(NoRedirect(),urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))
  with opener.open(req,timeout=10) as r:
   raw=r.read(16385)
   if len(raw)>16384: failure()
   return r.status,json.loads(raw or b'{}')
 except urllib.error.HTTPError as e: return e.code,{}
 except Exception: failure()
status,auth=search('GET','/_plugins/_security/authinfo')
own,_=search('HEAD','/'+own_index); foreign_status,_=search('HEAD','/'+foreign['nativeScope']+'_documents')
admin,_=search('GET','/_plugins/_security/api/internalusers')
try:
 import boto3
 from botocore.config import Config
 from botocore.exceptions import ClientError
 s3=boto3.client('s3',endpoint_url=os.environ.get('S3_ENDPOINT_URL'),aws_access_key_id=os.environ.get('S3_AWS_ACCESS_KEY_ID'),aws_secret_access_key=os.environ.get('S3_AWS_SECRET_ACCESS_KEY'),region_name='us-east-1',config=Config(connect_timeout=5,read_timeout=10,retries={'total_max_attempts':1,'mode':'standard'},proxies={}))
 def s3result(fn):
  try: return 200,fn()
  except ClientError as e: return int(e.response.get('ResponseMetadata',{}).get('HTTPStatusCode',0)),{}
  except Exception: failure()
 bucket_own,_=s3result(lambda:s3.head_bucket(Bucket=own_bucket))
 bucket_foreign,_=s3result(lambda:s3.head_bucket(Bucket=foreign['nativeScope'].replace('_','-')+'-files'))
 bucket_global,bucket_listing=s3result(lambda:s3.list_buckets())
 buckets=bucket_listing.get('Buckets') if isinstance(bucket_listing,dict) else None
 names=[item.get('Name') for item in buckets] if isinstance(buckets,list) and len(buckets)<=1 and all(isinstance(item,dict) for item in buckets) else []
 bucket_list_scoped=bucket_global==403 or (bucket_global==200 and names==[own_bucket] and all(name!=foreign['nativeScope'].replace('_','-')+'-files' for name in names))
except Exception: failure()
checks={'runtime_scope_exact':True,'native_overlay_pinned':True,'namespace_storage_config_exact':True,
 'search_runtime_identity':status==200 and isinstance(auth,dict) and auth.get('user_name')==user and auth.get('roles')==[user],
 'search_own_scope_available':own==200,'search_foreign_scope_denied':foreign_status==403,'search_admin_denied':admin==403,
 'bucket_own_scope_available':bucket_own==200,'bucket_foreign_scope_denied':bucket_foreign==403,'bucket_global_list_scoped':bucket_list_scoped}
if set(checks)!=set(payload['checks']): failure()
print(json.dumps({'schema_version':1,'scope':scope,'checks':checks},sort_keys=True,separators=(',',':')))
'''


def probe_source(scope: dict[str, Any], foreign: dict[str, Any]) -> str:
    payload = {"scope": scope, "foreign": foreign, "checks": sorted(PROBE_CHECKS)}
    return (PROBE.replace("__PAYLOAD__", repr(json.dumps(payload, sort_keys=True, separators=(",", ":"))))
            .replace("__PINNED__", repr(PINNED_ONYX_SOURCE)))


def probe(container_id: str, scope: dict[str, Any], foreign: dict[str, Any]) -> dict[str, Any]:
    # The source, including the fixed trusted scopes, is stdin.  The command
    # line contains neither a secret nor a user-controlled path or scope.
    output = _run(["docker", "exec", "-i", container_id, "python", "-B", "-"],
                  input_data=probe_source(scope, foreign), limit=MAX_PROBE_OUTPUT)
    try:
        value = json.loads(output)
    except (ValueError, TypeError):
        raise VerificationError() from None
    if (not isinstance(value, dict) or set(value) != {"schema_version", "scope", "checks"}
            or value.get("schema_version") != 1 or value.get("scope") != scope
            or not isinstance(value.get("checks"), dict) or set(value["checks"]) != PROBE_CHECKS
            or not all(item is True for item in value["checks"].values())):
        raise VerificationError()
    return value


def receipt(live: dict[str, Any], qa: dict[str, Any], live_container: dict[str, str], qa_container: dict[str, str],
            live_probe: dict[str, Any], qa_probe: dict[str, Any]) -> dict[str, Any]:
    result = {"schema_version": 1, "ok": True, "storage_acl_only": True,
              "browser_storage_verified": False,
              "live": {"business_id": live["businessId"], "deployment_id": live["deploymentId"],
                       "namespace": live["nativeScope"], "revision": live["revision"],
                       "api_image_id": live_container["image_id"]},
              "qa": {"business_id": qa["businessId"], "deployment_id": qa["deploymentId"],
                     "namespace": qa["nativeScope"], "revision": qa["revision"],
                     "api_image_id": qa_container["image_id"]},
              "checks": {"live_container_binding": True, "qa_container_binding": True,
                         "live_runtime_acl": all(live_probe["checks"].values()),
                         "qa_runtime_acl": all(qa_probe["checks"].values())},
              "limitation": "read_only_per_contour_acl_not_cross_server_or_document_lifecycle_or_browser_storage"}
    if (set(result) != RECEIPT_KEYS or set(result["checks"]) != RECEIPT_CHECKS
            or not all(item is True for item in result["checks"].values())):
        raise VerificationError()
    return result


def run() -> dict[str, Any]:
    live = live_scope(_private_json(LIVE_OPERATOR_MANIFEST, LIVE_ROOT))
    qa = qa_scope(_private_json(QA_MANIFEST, QA_ROOT))
    live_image = backend_image(_private_json(LIVE_CATALOGUE, LIVE_ROOT))
    qa_image = backend_image(_private_json(QA_CATALOGUE, QA_ROOT))
    if live["deploymentId"] == qa["deploymentId"] or live["nativeScope"] == qa["nativeScope"]:
        raise VerificationError()
    live_container, qa_container = api_container(live, live_image), api_container(qa, qa_image)
    live_probe, qa_probe = probe(live_container["id"], live, qa), probe(qa_container["id"], qa, live)
    return receipt(live, qa, live_container, qa_container, live_probe, qa_probe)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="explicitly run the fixed read-only ACL proof")
    args = parser.parse_args(argv)
    if not args.run:
        parser.error("--run is required")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        parse_args(argv)
        print(json.dumps(run(), sort_keys=True, separators=(",", ":")))
        return 0
    except (VerificationError, OSError, ValueError):
        print("ONYX_LIVE_STORAGE_VERIFICATION_FAILED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
