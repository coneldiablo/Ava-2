#!/usr/bin/env python3
"""Run the fixed Onyx recipe in a disposable private QA contour.

This runner proves only the named process/dependency properties.  It never
claims RAG correctness, public routing, enrollment, or buyer acceptance.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time
import uuid

import module_deployment_helper as helper
from onyx_recipe_factory import IMAGE_KEYS, OnyxRecipeFactory, catalogue as validate_catalogue


BASE = Path("/opt/ava-acceptance/ecosystem-20260914")
BUSINESSES = (911001, 911002)
PHASES = ("prepare", "launch", "dependencies", "embeddings", "repeat", "stop")
INIT_SERVICES = ("search_security_init", "search_bootstrap", "blob_bootstrap")
MEMORY_MIB = 12800


def _private_new(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as output:
        os.chmod(path, 0o600)
        output.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def _scope(directory: Path) -> Path:
    if os.geteuid() != 0 or not directory.is_absolute() or directory.parent != BASE \
            or not re.fullmatch(r"onyx-recipe-qa-[a-z0-9][a-z0-9-]{0,40}", directory.name):
        raise ValueError("ISOLATED_QA_DIRECTORY_REQUIRED")
    helper.owned_path(directory, directory=True)
    mode = directory.stat().st_mode & 0o777
    if mode != 0o700:
        raise ValueError("ISOLATED_QA_DIRECTORY_REQUIRED")
    return directory


def _capacity() -> None:
    values = {key: int(value.split()[0]) for key, value in
              (line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())}
    reserve_kib = MEMORY_MIB * 1024
    if values["MemAvailable"] - reserve_kib < values["MemTotal"] * .20:
        raise ValueError("QA_CAPACITY_REQUIRED")


def _load_manifest(directory: Path) -> dict:
    _, value = helper.private_json(directory / "manifest.json")
    row = value.get("row", {})
    if (set(value) != {"qa_only", "buyer_acceptance", "rag_acceptance", "row", "payload"}
            or value.get("qa_only") is not True or value.get("buyer_acceptance") is not False
            or value.get("rag_acceptance") is not False or row.get("businessId") not in BUSINESSES
            or row.get("module") != "onyx" or not helper.UUID.fullmatch(row.get("id", ""))
            or row.get("namespace") != "ava_" + row["id"].replace("-", "")
            or row.get("sourceCommit") != helper.PINNED["onyx"]
            # Preserve the pre-gateway QA contours for inspection and stop;
            # new deployments below always reserve the complete 12800 MiB.
            or row.get("reservedMemoryMiB") not in (12288, MEMORY_MIB)):
        raise ValueError("QA_SCOPE_REQUIRED")
    return value


def initialize(directory: Path, business: int) -> dict:
    directory = _scope(directory)
    if business not in BUSINESSES:
        raise ValueError("QA_SCOPE_REQUIRED")
    # Root supplies this exact immutable-image catalogue.  QA never invents or
    # amends image/cache/overlay attestations.
    _, images = helper.private_json(directory / "catalogue.json")
    validate_catalogue(images)
    for image in {images[key] for key in IMAGE_KEYS}:
        try:
            inspected = json.loads(helper.run(["docker", "image", "inspect", image], timeout=20))
        except (ValueError, TypeError):
            raise ValueError("INSTALLED_IMMUTABLE_IMAGE_REQUIRED") from None
        if (not isinstance(inspected, list) or len(inspected) != 1
                or inspected[0].get("Id") != image.split("@")[-1]):
            raise ValueError("INSTALLED_IMMUTABLE_IMAGE_REQUIRED")
    if (directory / "manifest.json").exists() or (directory / "synthetic.sqlite").exists():
        raise ValueError("NEW_SYNTHETIC_DEPLOYMENT_REQUIRED")
    _capacity()
    deployment, lease = str(uuid.uuid4()), str(uuid.uuid4())
    row = {"id": deployment, "businessId": business, "module": "onyx", "revision": 1,
           "hostname": f"qa-{deployment[:8]}-{business}.knowledge.meludtech.tech",
           "namespace": "ava_" + deployment.replace("-", ""), "sourceCommit": helper.PINNED["onyx"],
           "reservedMemoryMiB": MEMORY_MIB}
    payload = {"deploymentId": deployment, "businessId": business, "revision": 1, "leaseToken": lease}
    database = directory / "synthetic.sqlite"
    db = sqlite3.connect(database)
    try:
        db.executescript("""CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER,name TEXT);
CREATE TABLE ava_module_deployments(id TEXT PRIMARY KEY,businessId INTEGER,module TEXT,hostname TEXT,
namespace TEXT,sourceCommit TEXT,revision INTEGER,state TEXT,leaseToken TEXT,leasedUntil INTEGER,
reservedMemoryMiB INTEGER);""")
        db.execute("INSERT INTO instances VALUES(?,1,?)", (business, f"AVA Onyx QA {business}"))
        db.execute("INSERT INTO ava_module_deployments VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                   (deployment, business, "onyx", row["hostname"], row["namespace"], row["sourceCommit"], 1,
                    "provisioning", lease, int(time.time() * 1000) + 60000, MEMORY_MIB))
        db.commit()
    finally:
        db.close()
    os.chmod(database, 0o600)
    manifest = {"qa_only": True, "buyer_acceptance": False, "rag_acceptance": False,
                "row": row, "payload": payload}
    _private_new(directory / "manifest.json", manifest)
    return manifest


class Heartbeat:
    def __init__(self, database: Path, row: dict, payload: dict):
        self.database, self.row, self.payload = database, row, payload
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def renew(self) -> None:
        db = sqlite3.connect(self.database)
        try:
            db.execute("UPDATE ava_module_deployments SET leasedUntil=? WHERE id=? AND state='provisioning' AND leaseToken=?",
                       (int(time.time() * 1000) + 60000, self.row["id"], self.payload["leaseToken"]))
            db.commit()
        finally:
            db.close()

    def _run(self) -> None:
        while not self.stop.wait(10):
            self.renew()

    def __enter__(self):
        self.renew(); self.thread.start(); return self

    def __exit__(self, *_args):
        self.stop.set(); self.thread.join(timeout=2)


def _compose(root: Path, namespace: str) -> list[str]:
    return ["docker", "compose", "--project-name", namespace, "--project-directory", str(root),
            "--env-file", "/dev/null", "-f", str(root / "compose.json")]


def _containers(launcher, row: dict) -> dict:
    items = launcher._containers(row["id"])
    result = {}
    for item in items:
        service = item.get("Config", {}).get("Labels", {}).get("com.docker.compose.service")
        if not service or service in result:
            raise ValueError("QA_CONTAINER_SET_INVALID")
        result[service] = item
    return result


def _runtime_mounts_private(containers: dict) -> bool:
    for name in ("api", "worker", "web", "inference_model", "indexing_model"):
        for mount in containers[name].get("Mounts", []):
            description = mount.get("Source", "") + "\n" + mount.get("Destination", mount.get("Target", ""))
            if any(secret in description for secret in ("admin.pem", "admin-key.pem", "mc-config.json", "runtime-password")):
                return False
    return True


def _runtime_networks_private(compose: dict) -> bool:
    networks = compose.get('networks', {})
    if networks.get('native') != {'internal': True} or set(networks) - {'native', 'ingress', 'access'}:
        return False
    for name in ('ingress', 'access'):
        if name in networks and networks[name] != {'external': True, 'name': 'ava-module-' + name}:
            return False
    services = compose.get('services', {})
    if not services:
        return False
    if any(service.get('networks') != ['native'] for name, service in services.items() if name != 'gateway'):
        return False
    if 'gateway' in services:
        attached = services['gateway'].get('networks', [])
        return len(attached) == 3 and set(attached) == set(networks) == {'native', 'ingress', 'access'}
    return networks == {'native': {'internal': True}}


SEARCH_PROBE = r'''import base64,json,os,ssl,urllib.error,urllib.request
u=os.environ['OPENSEARCH_ADMIN_USERNAME']; p=os.environ['OPENSEARCH_ADMIN_PASSWORD']
c=ssl.create_default_context(cafile=os.environ['OPENSEARCH_CA_CERTS'])
def call(method,path,data=None):
 h={'Authorization':'Basic '+base64.b64encode((u+':'+p).encode()).decode()}
 if data is not None: h['Content-Type']='application/json'; data=json.dumps(data).encode()
 try:
  with urllib.request.urlopen(urllib.request.Request('https://search:9200'+path,data=data,headers=h,method=method),context=c,timeout=10) as r:
   return r.status,json.loads(r.read(65537) or b'{}')
 except urllib.error.HTTPError as e: return e.code,{}
s,a=call('GET','/_plugins/_security/authinfo'); role=os.environ['AVA_DEPLOYMENT_NAMESPACE']+'_runtime'
idx=os.environ['AVA_DEPLOYMENT_NAMESPACE']+'_documents_qa'; other='ava_'+'0'*32+'_documents'
created,_=call('PUT','/'+idx,{}); deleted,_=call('DELETE','/'+idx)
foreign,_=call('HEAD','/'+other); admin,_=call('GET','/_plugins/_security/api/internalusers')
print(json.dumps({'identity':s==200 and a.get('user_name')==role and a.get('roles')==[role],
'owned_index':created in (200,201) and deleted in (200,404),'foreign_denied':foreign==403,'admin_denied':admin==403}))
'''


EMBEDDING_PROBE = r'''import json,math,time,urllib.request
texts=['AVA hotel knowledge retrieval verification sentence one.',
       'A reservation invoice has a different semantic meaning.',
       'AVA hotel knowledge retrieval verification sentence one.']
payload=json.dumps({'texts':texts,'model_name':'nomic-ai/nomic-embed-text-v1',
 'max_context_length':512,'normalize_embeddings':True,'text_type':'query',
 'manual_query_prefix':'search_query: '}).encode()
def service(name):
 started=time.monotonic()
 request=urllib.request.Request('http://'+name+':9000/encoder/bi-encoder-embed',data=payload,
  headers={'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(request,timeout=300) as response:
  if response.status!=200: raise RuntimeError('EMBED_STATUS')
  raw=response.read(8*1024*1024+1)
 if len(raw)>8*1024*1024: raise RuntimeError('EMBED_RESPONSE_SIZE')
 vectors=json.loads(raw).get('embeddings')
 if not isinstance(vectors,list) or len(vectors)!=3: raise RuntimeError('EMBED_SHAPE')
 shape=all(isinstance(vector,list) and len(vector)==768 for vector in vectors)
 finite=shape and all(type(value) in (int,float) and math.isfinite(value) for vector in vectors for value in vector)
 same=max((abs(float(a)-float(b)) for a,b in zip(vectors[0],vectors[2])),default=float('inf')) if shape else float('inf')
 distinct=math.sqrt(sum((float(a)-float(b))**2 for a,b in zip(vectors[0],vectors[1]))) if shape and finite else 0.0
 with urllib.request.urlopen('http://'+name+':9000/api/health',timeout=10) as health:
  healthy=health.status==200
 return {'checks':{'three_vectors':len(vectors)==3,'dimension_768':shape,'all_finite':finite,
  'distinct_text_vectors':distinct>1e-6,'repeat_stable':same<=1e-7,'health_after_model_load':healthy},
  'diagnostics':{'dimension':len(vectors[0]) if vectors and isinstance(vectors[0],list) else 0,
   'vector_count':len(vectors),'finite_value_count':sum(1 for vector in vectors if isinstance(vector,list) for value in vector if type(value) in (int,float) and math.isfinite(value)),
   'distinct_l2':round(distinct,9),'repeat_max_abs_delta':round(same,12),
   'latency_ms':round((time.monotonic()-started)*1000)}}
print(json.dumps({name:service(name) for name in ('inference_model','indexing_model')},sort_keys=True,separators=(',',':')))
'''


def _search_probe(root: Path, row: dict) -> dict:
    command = [*_compose(root, row["namespace"]), "run", "--rm", "--no-deps", "--entrypoint", "python", "api", "-"]
    output = subprocess.run(command, input=SEARCH_PROBE, text=True, capture_output=True, timeout=90, env=helper.SAFE_ENV)
    if output.returncode or len(output.stdout) > 4096:
        raise ValueError("QA_SEARCH_RUNTIME_PROBE_FAILED")
    try: proof = json.loads(output.stdout)
    except (ValueError, TypeError): raise ValueError("QA_SEARCH_RUNTIME_PROBE_FAILED") from None
    if set(proof) != {"identity", "owned_index", "foreign_denied", "admin_denied"} or not all(value is True for value in proof.values()):
        raise ValueError("QA_SEARCH_RUNTIME_PROBE_FAILED")
    return proof


def _embedding_probe(root: Path, row: dict) -> tuple[dict, dict]:
    # The fixed backend image is only a client here. Compose attaches it to the
    # contour's internal network; no host port or external network is added.
    command = [*_compose(root, row["namespace"]), "run", "--rm", "--no-deps",
               "--entrypoint", "python", "api", "-"]
    output = subprocess.run(command, input=EMBEDDING_PROBE, text=True, capture_output=True,
                            timeout=660, env=helper.SAFE_ENV)
    if output.returncode or len(output.stdout) > 8192:
        raise ValueError("QA_EMBEDDING_PROBE_FAILED")
    try:
        proof = json.loads(output.stdout)
    except (ValueError, TypeError):
        raise ValueError("QA_EMBEDDING_PROBE_FAILED") from None
    expected_checks = {"three_vectors", "dimension_768", "all_finite", "distinct_text_vectors",
                       "repeat_stable", "health_after_model_load"}
    expected_diagnostics = {"dimension", "vector_count", "finite_value_count", "distinct_l2",
                            "repeat_max_abs_delta", "latency_ms"}
    checks, diagnostics = {}, {}
    if set(proof) != {"inference_model", "indexing_model"}:
        raise ValueError("QA_EMBEDDING_PROBE_FAILED")
    for service in ("inference_model", "indexing_model"):
        item = proof.get(service)
        if (not isinstance(item, dict) or set(item) != {"checks", "diagnostics"}
                or set(item["checks"]) != expected_checks or set(item["diagnostics"]) != expected_diagnostics
                or not all(value is True for value in item["checks"].values())
                or any(type(value) not in (int, float) or not __import__("math").isfinite(value)
                       or value < 0 for value in item["diagnostics"].values())):
            raise ValueError("QA_EMBEDDING_PROBE_FAILED")
        checks.update({service + "_" + key: value for key, value in item["checks"].items()})
        diagnostics[service] = item["diagnostics"]
    return checks, diagnostics


def _blob_probe(directory: Path, root: Path, row: dict) -> dict:
    _, catalogue = helper.private_json(directory / "catalogue.json")
    _, config = helper.private_json(root / "config/mc-config.json")
    runtime = config.get("aliases", {}).get("runtime")
    if not isinstance(runtime, dict) or set(runtime) != {"url", "accessKey", "secretKey", "api", "path"}:
        raise ValueError("QA_BLOB_RUNTIME_PROBE_FAILED")
    image, uid, gid = catalogue["blobClientImage"], catalogue["blobUid"], catalogue["blobGid"]
    probe_config = root / "config/qa-runtime-mc.json"
    content = {"version": "10", "aliases": {"runtime": runtime}}
    if probe_config.exists():
        info = probe_config.lstat()
        if (not probe_config.is_file() or probe_config.is_symlink() or info.st_uid != 0
                or info.st_gid != gid or info.st_mode & 0o777 != 0o440
                or json.loads(probe_config.read_text(encoding="utf-8")) != content):
            raise ValueError("QA_BLOB_RUNTIME_PROBE_FAILED")
    else:
        with probe_config.open("x", encoding="utf-8") as output:
            output.write(json.dumps(content, sort_keys=True, separators=(",", ":")) + "\n")
        os.chown(probe_config, 0, gid); os.chmod(probe_config, 0o440)
    network, bucket = row["namespace"] + "_native", row["namespace"].replace("_", "-") + "-files"
    base = ["docker", "run", "--rm", "-i", "--network", network, "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
            "--user", f"{uid}:{gid}", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
            "--mount", f"type=bind,src={probe_config},dst=/tmp/config.json,readonly",
            "-e", "MC_CONFIG_DIR=/tmp", image]
    def run_mc(arguments: list[str], data: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([*base, *arguments], input=data, text=True, capture_output=True,
                              timeout=30, env=helper.SAFE_ENV)
    name = "qa-runtime-proof"
    put = run_mc(["pipe", f"runtime/{bucket}/{name}"], "ava-qa-proof")
    get = run_mc(["cat", f"runtime/{bucket}/{name}"])
    delete = run_mc(["rm", f"runtime/{bucket}/{name}"])
    admin = run_mc(["admin", "info", "runtime"])
    proof = {"owned_object": put.returncode == 0 and get.returncode == 0 and get.stdout == "ava-qa-proof" and delete.returncode == 0,
             "admin_denied": admin.returncode != 0}
    if not all(proof.values()): raise ValueError("QA_BLOB_RUNTIME_PROBE_FAILED")
    return proof


def execute(directory: Path, phase: str, business: int | None = None) -> dict:
    directory = _scope(directory)
    if phase not in PHASES: raise ValueError("QA_PHASE_INVALID")
    if phase == "prepare" and not (directory / "manifest.json").exists():
        if business is None: raise ValueError("QA_SCOPE_REQUIRED")
        manifest = initialize(directory, business)
    else:
        if business is not None: raise ValueError("QA_SCOPE_REQUIRED")
        manifest = _load_manifest(directory)
    row, payload = manifest["row"], manifest["payload"]
    database = directory / "synthetic.sqlite"
    factory = OnyxRecipeFactory(directory, directory / "catalogue.json", database)
    launcher = helper.Deployments(database, directory, recipe_factory=factory)
    checks, diagnostics = {}, {}
    with Heartbeat(database, row, payload):
        if phase == "prepare":
            factory.prepare(row)
            root, recipe, compose = launcher._recipe(row)
            checks = {"fixed_recipe_prepared": recipe["memoryMiB"] == MEMORY_MIB,
                      "fourteen_services": len(compose["services"]) == 14,
                      "private_runtime_networks": _runtime_networks_private(compose),
                      "auth_and_gateway_included": {'auth', 'gateway'}.issubset(compose['services']),
                      "catalogue_was_root_supplied": (directory / "catalogue.json").is_file()}
        elif phase == "launch":
            launcher.execute("provision", payload)
            root, _recipe, _compose_value = launcher._recipe(row)
            containers = _containers(launcher, row)
            checks = {"launch_requested_for_owned_project": bool(containers),
                      "no_published_ports": all(not item.get("HostConfig", {}).get("PortBindings") for item in containers.values()),
                      "runtime_has_no_admin_secret_mounts": set(containers) >= {"api", "worker", "web", "inference_model", "indexing_model"} and _runtime_mounts_private(containers)}
        elif phase == "dependencies":
            root, _recipe, compose = launcher._recipe(row)
            containers = _containers(launcher, row)
            if set(containers) != set(compose["services"]): raise ValueError("QA_CONTAINER_SET_INVALID")
            init_ok = all(containers[name].get("State", {}).get("Status") == "exited" and containers[name].get("State", {}).get("ExitCode") == 0 for name in INIT_SERVICES)
            network = json.loads(helper.run(["docker", "network", "inspect", row["namespace"] + "_native"], timeout=15))[0]
            search, blob = _search_probe(root, row), _blob_probe(directory, root, row)
            checks = {"all_dependency_initializers_exit_zero": init_ok,
                      "no_dependency_oom_kills": all(not item.get("State", {}).get("OOMKilled") for item in containers.values()),
                      "runtime_has_no_admin_secret_mounts": _runtime_mounts_private(containers),
                      "no_published_ports": all(not item.get("HostConfig", {}).get("PortBindings") for item in containers.values()),
                      "internal_network": network.get("Internal") is True,
                      **{"search_" + key: value for key, value in search.items()},
                      **{"blob_" + key: value for key, value in blob.items()}}
        elif phase == "embeddings":
            root, _recipe, compose = launcher._recipe(row)
            containers = _containers(launcher, row)
            if set(containers) != set(compose["services"]): raise ValueError("QA_CONTAINER_SET_INVALID")
            checks, diagnostics = _embedding_probe(root, row)
            checks["internal_client_network"] = (_runtime_networks_private(compose)
                                                  and compose["services"]["api"]["networks"] == ["native"])
            checks["embedding_health_is_not_rag_acceptance"] = True
        elif phase == "repeat":
            root, _recipe, compose = launcher._recipe(row)
            factory.prepare(row)
            containers = _containers(launcher, row)
            for name in INIT_SERVICES:
                helper.run(["docker", "start", "--attach", containers[name]["Id"]], timeout=240)
            health = {}
            for _ in range(180):
                containers = _containers(launcher, row)
                health = {name: containers[name].get("State", {}).get("Health", {}).get("Status") == "healthy"
                          for name in ("api", "inference_model", "indexing_model")}
                if all(health.values()): break
                time.sleep(2)
            checks = {"bootstrap_replay_exit_zero": all(containers[name].get("State", {}).get("ExitCode") == 0 for name in INIT_SERVICES),
                      "api_process_healthy": health["api"], "inference_process_healthy": health["inference_model"],
                      "indexing_process_healthy": health["indexing_model"], "health_is_not_rag_acceptance": True}
        else:
            root, _recipe, compose_value = launcher._recipe(row)
            launcher._state(row, compose_value)
            # Stop exactly the validated Compose project.  Deliberately no down,
            # rm, volume removal, network deletion, or foreign label selector.
            helper.run([*_compose(root, row["namespace"]), "stop", "--timeout", "15"], timeout=60)
            checks = {"owned_project_stopped": True, "volumes_retained": True}
    if not checks or not all(value is True for value in checks.values()):
        raise ValueError("QA_CHECK_FAILED")
    result = {"qa_only": True, "buyer_acceptance": False, "rag_acceptance": False,
              "phase": phase, "business_id": row["businessId"], "deployment_id": row["id"],
              "checks": checks, "diagnostics": diagnostics}
    _private_new(directory / f"{phase}-{time.time_ns()}-result.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--business", type=int, choices=BUSINESSES)
    parser.add_argument("--phase", choices=PHASES, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(execute(args.directory, args.phase, args.business), sort_keys=True), flush=True)
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, helper.DeploymentError)) else "QA_INTERNAL_FAILURE"
        if not re.fullmatch(r"[A-Z0-9_]{1,80}", code): code = "QA_INTERNAL_FAILURE"
        raise SystemExit("AVA_ONYX_RECIPE_QA_FAILED:" + code) from None
