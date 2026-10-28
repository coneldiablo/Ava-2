#!/usr/bin/env python3
"""Private, guarded three-container release. No credentials are printed."""
import argparse
import copy
import fcntl
from contextlib import closing
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
from urllib.request import urlopen

NAMES = {"engine": "ai_engine", "crm": "whatsapp_crm", "worker": "asterisk-ai-voice-agent-provisioning_worker-1"}
PRIVATE = Path("/root/ava-private/neuro-gemini-20261014")
PUBLIC_FIELDS = ["enabled", "llm_model", "model", "voice", "voice_name", "tts_voice_name", "tts_model", "tts_voice", "kokoro_voice", "role", "use_vertex_ai", "vertex_project", "project_id"]


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def private_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=path.name + ".", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)


def run(command, **kwargs):
    execution_env = dict(os.environ)
    # Required image-name interpolation in retained historical compose files.
    # Selected services always receive explicit pinned image IDs in our override.
    execution_env.setdefault("AVA_RELEASE_SHA", "b3be6ee")
    execution_env.setdefault("AVA_CALL_ANALYTICS_SHA", "da737f3")
    kwargs.setdefault("env", execution_env)
    result = subprocess.run(command, capture_output=True, text=True, timeout=kwargs.pop("timeout", 120), **kwargs)
    if result.returncode:
        if LOG_ROOT:
            (LOG_ROOT / "last-command.private.log").write_text(result.stdout + result.stderr)
        raise RuntimeError("COMMAND_FAILED")
    return result.stdout


def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]


def envmap(row):
    return dict(v.split("=", 1) for v in row["Config"]["Env"])


def compose(row, override=None):
    labels = row["Config"]["Labels"]
    command = ["docker", "compose", "-p", labels["com.docker.compose.project"]]
    for path in labels.get("com.docker.compose.project.environment_file", "").split(","):
        if path:
            require(Path(path).is_file(), "ENV_FILE_MISSING")
            command += ["--env-file", path]
    for path in labels["com.docker.compose.project.config_files"].split(","):
        require(Path(path).is_file(), "COMPOSE_FILE_MISSING")
        command += ["-f", path]
    if override:
        command += ["-f", str(override)]
    return command, labels["com.docker.compose.project.working_dir"], labels["com.docker.compose.service"]


def rendered(row, override=None):
    command, cwd, service = compose(row, override)
    value = json.loads(run(command + ["config", "--format", "json"], cwd=cwd))["services"][service]
    value["environment"] = {k: v.replace("$$", "$") if isinstance(v, str) else v for k, v in value.get("environment", {}).items()}
    return value


def mount_signature(volumes, live=False):
    result = []
    for volume in volumes:
        kind = volume.get("Type" if live else "type")
        require(kind == "bind", "UNREVIEWED_MOUNT_TYPE")
        source = volume.get("Source" if live else "source")
        target = volume.get("Destination" if live else "target")
        readonly = not volume.get("RW") if live else bool(volume.get("read_only", False))
        propagation = (volume.get("Propagation") if live else volume.get("bind", {}).get("propagation")) or "rprivate"
        result.append((kind, str(Path(source).resolve()), target, readonly, propagation))
    return sorted(result)


def backup(source, target):
    require(not target.exists(), "BACKUP_EXISTS")
    with closing(sqlite3.connect(Path(source).resolve().as_uri() + "?mode=ro", uri=True, timeout=30)) as src, closing(sqlite3.connect(target)) as dst:
        src.execute("BEGIN")
        schema = src.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        require(schema, "SOURCE_DATABASE_EMPTY")
        def counts(connection):
            # Extension-backed virtual tables cannot be opened by a plain
            # sqlite3 connection; their physical shadow tables are still copied
            # and counted, and their CREATE statements are compared verbatim.
            return {name: connection.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
                    for name, sql in schema if not (sql or '').lstrip().upper().startswith("CREATE VIRTUAL TABLE")}
        expected_counts = counts(src)
        src.backup(dst)
        require(dst.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "BACKUP_INVALID")
        require(dst.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall() == schema,
                "BACKUP_SCHEMA_MISMATCH")
        require(counts(dst) == expected_counts, "BACKUP_ROWS_MISMATCH")
        dst.execute("PRAGMA journal_mode=DELETE")
        dst.commit()
    target.chmod(0o600)
    return {"path": str(target), "sha256": sha(target), "verifiedTables": len(schema)}


def other_containers():
    ids = run(["docker", "ps", "-aq"]).split()
    rows = json.loads(run(["docker", "inspect", *ids])) if ids else []
    return {r["Name"].lstrip("/"): [r["Id"], r["Image"], r["State"]["Running"]] for r in rows if r["Name"].lstrip("/") not in NAMES.values()}


def private_env(path, values):
    require(all("\n" not in str(v) and "\r" not in str(v) for v in values.values()), "MULTILINE_ENV_UNSUPPORTED")
    path.write_text("".join(k + "=" + str(v) + "\n" for k, v in values.items()))
    path.chmod(0o600)


def prepare(root):
    require(not (root / "prepared.private.json").exists(), "ALREADY_PREPARED")
    # Retain failed prepare artifacts privately; a prepare never changes live
    # containers/configuration and must not reuse an earlier database snapshot.
    owned = ["engine-config", "voice-config", "prepare-crm.db", "engine-before.env", "crm-before.env", "worker-before.env",
             "engine.candidate.private.json", "crm.candidate.private.json", "worker.candidate.private.json", "last-command.private.log"]
    if any((root / name).exists() for name in owned):
        attempt = root / ("prepare-attempt-" + str(time.time_ns()))
        attempt.mkdir(mode=0o700)
        for name in owned:
            if (root / name).exists():
                (root / name).rename(attempt / name)
    images = json.loads((root / "images.json").read_text())
    before = {role: inspect(name) for role, name in NAMES.items()}
    engine_manifest = json.loads((root / "engine-0882143-b4/manifest.json").read_text())
    crm_manifest = json.loads((root / "crm-0882143-b4/manifest.json").read_text())
    for role, row in before.items():
        expected = engine_manifest["baseImage"] if role == "engine" else crm_manifest["services"][role]["baseImage"]
        require(row["Image"] == expected and row["State"]["Running"], "BASE_CONTAINER_CHANGED")
    inputs = {}
    for row in before.values():
        labels = row["Config"]["Labels"]
        for key in ("com.docker.compose.project.config_files", "com.docker.compose.project.environment_file"):
            for path in labels.get(key, "").split(","):
                if path:
                    inputs[path] = sha(path)
    engine_mount = next(m for m in before["engine"]["Mounts"] if m["Destination"] == "/app/config")
    live_config = Path(engine_mount["Source"]) / "ai-agent.yaml"
    require(live_config.is_file(), "ENGINE_CONFIG_MISSING")
    original_config_hash = sha(live_config)
    staged = root / "engine-config"
    shutil.copytree(live_config.parent, staged)
    private_env(root / "engine-before.env", envmap(before["engine"]))
    public = root / "voice-config"
    public.mkdir(mode=0o755)
    public.chmod(0o755)
    config_script = '''import pathlib,yaml,os,json
from src.config import load_config
root=pathlib.Path('/release');path=root/'engine-config/ai-agent.yaml';data=yaml.safe_load(path.read_text());original=dict(data.get('providers') or {})
data.setdefault('providers',{})['neuro_gemini']={'enabled':True,'endpoint':'https://speech.neuro.net','project_id':'project-70a86530-dd7e-4201-b95','location':'global','model':'gemini-3.8-flash','thinking_level':'LOW','voice_name':'edsel'}
assert {k:v for k,v in data['providers'].items() if k!='neuro_gemini'}=={k:v for k,v in original.items() if k!='neuro_gemini'}
path.write_text(yaml.safe_dump(data,sort_keys=False,allow_unicode=True));cfg=load_config(str(path));providers={}
fields=''' + repr(PUBLIC_FIELDS) + '''
for name,value in cfg.providers.items():
 if name not in ('neuro_gemini','google_live','openai_realtime','yandex_realtime','deepgram','local'):continue
 value=value.model_dump() if hasattr(value,'model_dump') else value
 if not isinstance(value,dict):continue
 block={k:value[k] for k in fields if k in value and isinstance(value[k],(str,bool,int,float))}
 if name=='local':ready=bool(value.get('base_url') or value.get('llm_base_url'))
 elif name=='google_live' and value.get('use_vertex_ai'):ready=bool(value.get('vertex_project'))
 elif name=='yandex_realtime':ready=bool(value.get('api_key') and value.get('folder_id'))
 elif name=='neuro_gemini':ready=bool(value.get('api_key') and value.get('project_id'))
 else:ready=bool(value.get('api_key'))
 block['credentials_configured']=ready;providers[name]=block
out={'default_provider':cfg.default_provider,'providers':providers};(root/'voice-config/ai-agent.yaml').write_text(yaml.safe_dump(out,sort_keys=False,allow_unicode=True));print(json.dumps({'defaultProvider':cfg.default_provider,'providers':{k:{'enabled':v.get('enabled',True),'configured':v['credentials_configured']} for k,v in providers.items()}}))
'''
    output = run(["docker", "run", "--rm", "-i", "--user", "0", "--network", "none", "--env-file", str(root / "engine-before.env"),
                  "--env-file", str(PRIVATE / "voice.env"), "--mount", f"type=bind,src={root},dst=/release",
                  "--entrypoint", "python", images["engine"], "-"], input=config_script)
    (root / "config-prepare.private.log").write_text(output)
    (public / "ai-agent.yaml").chmod(0o444)
    db_mount = next(m for m in before["crm"]["Mounts"] if m["Destination"] == "/app/data")
    database = Path(db_mount["Source"]) / "crm_v2.db"
    worker_mount = next(m for m in before["worker"]["Mounts"] if m["Destination"] == "/app/data")
    require(database.resolve() == (Path(worker_mount["Source"]) / "crm_v2.db").resolve(), "CRM_WORKER_DATABASE_SPLIT")
    initial_backup = backup(database, root / "prepare-crm.db")
    overrides, intended = {}, {}
    voice_env = dict(line.split("=", 1) for line in (PRIVATE / "voice.env").read_text().splitlines() if line and not line.startswith("#"))
    for role, row in before.items():
        actual = envmap(row)
        private_env(root / (role + "-before.env"), actual)
        baseline = rendered(row)
        require(mount_signature(baseline.get("volumes", [])) == mount_signature(row.get("Mounts", []), live=True), "LIVE_COMPOSE_MOUNT_DRIFT")
        require(set(baseline.get("environment", {})) <= set(actual), "ENV_DRIFT_ON_DISK")
        extra = dict(voice_env)
        if role != "engine":
            extra.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
            extra["AVA_VOICE_CONFIG_PATH"] = "/app/voice-config/ai-agent.yaml"
        expected = copy.deepcopy(baseline)
        expected.update(image=images[role], environment={**actual, **extra})
        volumes = list(expected.get("volumes", []))
        addition = {"type": "bind", "source": str(PRIVATE / "vertex-adc.json"), "target": "/run/secrets/ava-vertex-adc.json", "read_only": True} if role == "engine" else {"type": "bind", "source": str(public), "target": "/app/voice-config", "read_only": True}
        require(not any(v.get("target") == addition["target"] for v in volumes), "SECRET_MOUNT_ALREADY_PRESENT")
        volumes.append(addition)
        service = row["Config"]["Labels"]["com.docker.compose.service"]
        override = root / (role + ".candidate.private.json")
        private_json(override, {"services": {service: {"image": images[role], "environment": {k: v.replace("$", "$$") for k, v in expected["environment"].items()}, "volumes": [addition]}}})
        value = rendered(row, override)
        require(value["image"] == images[role] and value["environment"] == expected["environment"], "RENDERED_ENV_MISMATCH")
        for key in set(value) | set(baseline):
            if key not in ("image", "environment", "volumes"):
                require(value.get(key) == baseline.get(key), "UNRELATED_COMPOSE_CHANGE")
        require(mount_signature(value.get("volumes", [])) == mount_signature(volumes), "UNRELATED_VOLUME_CHANGE")
        overrides[role] = str(override)
        intended[role] = value
        private_json(root / (role + ".rollback.private.json"), {"services": {service: {"image": row["Image"], "environment": {k: v.replace("$", "$$") for k, v in actual.items()}, "volumes": []}}})
    record = {"sourceCommit": engine_manifest["candidateCommit"], "before": before, "images": images, "inputs": inputs,
              "otherContainers": other_containers(), "liveConfig": str(live_config), "configBeforeHash": original_config_hash,
              "stagedConfig": str(staged / "ai-agent.yaml"), "configAfterHash": sha(staged / "ai-agent.yaml"),
              "database": str(database), "prepareBackup": initial_backup, "overrides": overrides, "intended": intended}
    stat = database.stat()
    record["databaseMetadata"] = [stat.st_uid, stat.st_gid, stat.st_mode & 0o777]
    shutil.copy2(live_config, root / "ai-agent.before.private.yaml")
    private_json(root / "prepared.private.json", record)
    print(json.dumps({"phase": "prepared", "sourceCommit": record["sourceCommit"], "services": list(NAMES), "defaultPreserved": True, "backup": initial_backup}))


def load(root):
    return json.loads((root / "prepared.private.json").read_text())


def guard_original(p):
    for role, name in NAMES.items():
        row = inspect(name)
        require(row["Id"] == p["before"][role]["Id"] and row["Image"] == p["before"][role]["Image"], "LIVE_CONTAINER_DRIFT")
        require(row["State"]["Running"] and not row["State"].get("Paused")
                and row.get("RestartCount") == p["before"][role].get("RestartCount"), "LIVE_SERVICE_STATE_DRIFT")
    require(all(sha(path) == value for path, value in p["inputs"].items()), "COMPOSE_INPUT_DRIFT")
    require(sha(p["liveConfig"]) == p["configBeforeHash"], "LIVE_CONFIG_DRIFT")
    require(sha(p["stagedConfig"]) == p["configAfterHash"], "STAGED_CONFIG_DRIFT")
    require(other_containers() == p["otherContainers"], "UNRELATED_CONTAINER_DRIFT")


def idle():
    output = run(["asterisk", "-rx", "core show channels count"], timeout=15)
    require(re.search(r"(?m)^\s*0 active channels\s*$", output) and re.search(r"(?m)^\s*0 active calls\s*$", output), "ACTIVE_CALLS")
    try:
        with urlopen("http://127.0.0.1:15000/health", timeout=8) as response:
            value = json.load(response)
    except Exception:
        # A stopped engine cannot retain an active session; Asterisk's zero
        # channel/call gate above still applies. A running but unreachable
        # process never receives this recovery exemption.
        state = inspect(NAMES["engine"])["State"]
        require(not state["Running"] and not state.get("Paused"), "ENGINE_IDLE_UNCONFIRMED")
        return
    require(value.get("active_calls") == 0 and value.get("active_sessions") == 0, "ACTIVE_AI_SESSIONS")


def replace_config(p, source, expected):
    target = Path(p["liveConfig"])
    require(sha(target) == expected, "CONFIG_CHANGED_BEFORE_REPLACE")
    source_bytes = Path(source).read_bytes()
    wanted = p["configAfterHash"] if Path(source) == Path(p["stagedConfig"]) else p["configBeforeHash"]
    require(hashlib.sha256(source_bytes).hexdigest() == wanted, "REPLACEMENT_CONFIG_DRIFT")
    stat = target.stat()
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".neuro-config-", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(source_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    os.chown(temporary, stat.st_uid, stat.st_gid)
    temporary.chmod(stat.st_mode & 0o777)
    os.replace(temporary, target)


def check_container(p, role, rollback=False, active=False, allow_unhealthy=False):
    row, before = inspect(NAMES[role]), p["before"][role]
    image = before["Image"] if rollback else p["images"][role]
    require(row["Image"] == image, "INSTALLED_IMAGE_NOT_RUNNING")
    if not allow_unhealthy:
        require(row["State"]["Running"] and not row["State"].get("Paused"), "INSTALLED_IMAGE_NOT_RUNNING")
        require(row.get("RestartCount") == 0, "SERVICE_RESTARTED")
    expected_env = envmap(before) if rollback else (p["activationIntended"] if active else p["intended"])[role]["environment"]
    require(envmap(row) == expected_env, "INSTALLED_ENV_MISMATCH")
    mounts = mount_signature(before["Mounts"], live=True) if rollback else mount_signature((p["activationIntended"] if active else p["intended"])[role]["volumes"])
    require(mount_signature(row["Mounts"], live=True) == mounts, "INSTALLED_MOUNT_MISMATCH")
    require(set(row["NetworkSettings"]["Networks"]) == set(before["NetworkSettings"]["Networks"]), "NETWORK_CHANGED")
    for key in ("PortBindings", "RestartPolicy", "LogConfig", "Privileged", "CapAdd", "CapDrop", "SecurityOpt", "Devices", "NetworkMode", "Tmpfs"):
        require(row["HostConfig"].get(key) == before["HostConfig"].get(key), "HOST_CONFIG_CHANGED")
    for key in ("User", "Entrypoint", "Cmd", "WorkingDir"):
        require(row["Config"].get(key) == before["Config"].get(key), "PROCESS_CONFIG_CHANGED")
    if role == "crm" and not allow_unhealthy:
        require(row["State"].get("Health", {}).get("Status") == "healthy", "CRM_NOT_HEALTHY")
    return row


def up(p, role, override, rollback=False, active=False):
    require(all(sha(path) == value for path, value in p["inputs"].items()), "COMPOSE_INPUT_DRIFT")
    value = rendered(p["before"][role], override)
    if rollback:
        require(value["image"] == p["before"][role]["Image"]
                and value["environment"] == envmap(p["before"][role]), "ROLLBACK_RENDER_DRIFT")
        require(mount_signature(value.get("volumes", [])) == mount_signature(p["before"][role]["Mounts"], live=True), "ROLLBACK_MOUNT_DRIFT")
    else:
        require(value == (p["activationIntended"] if active else p["intended"])[role], "CANDIDATE_RENDER_DRIFT")
    command, cwd, service = compose(p["before"][role], override)
    run(command + ["up", "-d", "--no-deps", "--pull", "never", "--force-recreate", service], cwd=cwd, timeout=180)
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        row = inspect(NAMES[role])
        require(row.get("RestartCount") == 0, "SERVICE_RESTARTED")
        if row["State"]["Running"] and (role != "crm" or row["State"].get("Health", {}).get("Status") == "healthy"):
            time.sleep(2)
            check_container(p, role, rollback=rollback, active=active)
            if role == "engine":
                # Running means only that PID 1 exists. The health listener,
                # ARI and AudioSocket start later; do not advance or roll back
                # merely because that normal startup window is still open.
                try:
                    with urlopen("http://127.0.0.1:15000/health", timeout=5) as response:
                        health = json.load(response)
                    ready = (health.get("status") == "healthy" and health.get("ari_connected") is True
                             and health.get("audiosocket", {}).get("listening") is True)
                    if not rollback:
                        ready = ready and health.get("providers", {}).get("neuro_gemini", {}).get("ready") is True
                    if not ready:
                        continue
                except (OSError, ValueError):
                    continue
            return
        time.sleep(2)
    raise RuntimeError("SERVICE_HEALTH_TIMEOUT")


def stage_admission(root, p):
    require(not (root / "apply-started.private.json").exists(), "APPLY_ALREADY_STARTED")
    # Persist immutable canonical intent before any derived override is written.
    # A retry after a partial render always reconstructs both sets from this map.
    if "activationIntended" not in p:
        p["activationIntended"] = copy.deepcopy(p["intended"])
    require(all(p["activationIntended"][r]["environment"].get("NEURO_GEMINI_ENABLED") == "true"
                for r in ("crm", "worker")), "ACTIVATION_INTENT_INVALID")
    p["intended"] = copy.deepcopy(p["activationIntended"])
    for role in ("crm", "worker"):
        p["intended"][role]["environment"]["NEURO_GEMINI_ENABLED"] = "false"
    p["activationOverrides"] = {}
    private_json(root / "prepared.private.json", p)
    for role in ("crm", "worker"):
        service = p["before"][role]["Config"]["Labels"]["com.docker.compose.service"]
        def override(intent):
            block = {k: copy.deepcopy(v) for k, v in intent.items() if k in ("image", "environment", "volumes")}
            block["environment"] = {k: v.replace("$", "$$") if isinstance(v, str) else v
                                    for k, v in block["environment"].items()}
            return {"services": {service: block}}
        active_path = root / (role + ".active.private.json")
        private_json(active_path, override(p["activationIntended"][role]))
        p["activationOverrides"][role] = str(active_path)
        private_json(Path(p["overrides"][role]), override(p["intended"][role]))
        require(rendered(p["before"][role], p["overrides"][role]) == p["intended"][role], "ADMISSION_STAGE_RENDER_MISMATCH")
        require(rendered(p["before"][role], active_path) == p["activationIntended"][role], "ADMISSION_ACTIVE_RENDER_MISMATCH")
    p["activationOverrides"]["engine"] = p["overrides"]["engine"]
    private_json(root / "prepared.private.json", p)


def migrate_live(root, p):
    probe = root / "tooling/migration_probe.cjs"
    require(probe.is_file(), "MIGRATION_PROBE_MISSING")
    source = Path(p["database"])
    result = run(["docker", "run", "--rm", "--network", "none", "--user", "1000:986", "--env-file", str(root / "crm-before.env"),
                  "-e", "DB_PATH=/verify/" + source.name, "-e", "AVA_PROCESS_ROLE=provisioning-worker",
                  "--mount", f"type=bind,src={source.parent},dst=/verify", "--mount", f"type=bind,src={probe},dst=/release/migration_probe.cjs,readonly",
                  "--entrypoint", "node", p["images"]["crm"], "/release/migration_probe.cjs", "apply"], timeout=120)
    value = json.loads(result)
    require(value.get("ok") is True and value.get("mode") == "apply" and value.get("initVerified") is True
            and value.get("voiceColumnsVerified") is True and value.get("exactDataFence") is False, "LIVE_MIGRATION_FAILED")
    stat = source.stat()
    require([stat.st_uid, stat.st_gid, stat.st_mode & 0o777] == p["databaseMetadata"], "DATABASE_OWNERSHIP_CHANGED")
    private_json(root / "migration-live.private.json", value)


def verify(root, rollback=False, active=False):
    p = load(root)
    rows = {role: check_container(p, role, rollback=rollback, active=active) for role in NAMES}
    require(other_containers() == p["otherContainers"], "UNRELATED_CONTAINER_CHANGED")
    with urlopen("http://127.0.0.1:15000/health", timeout=10) as response:
        health = json.load(response)
    require(health.get("status") == "healthy" and health.get("ari_connected") is True and health.get("audiosocket", {}).get("listening") is True, "ENGINE_NOT_READY")
    if not rollback:
        require(health.get("providers", {}).get("neuro_gemini", {}).get("ready") is True, "NEURO_PROVIDER_NOT_READY")
    require(sha(p["liveConfig"]) == p["configBeforeHash" if rollback else "configAfterHash"], "INSTALLED_CONFIG_CHANGED")
    return {"sourceCommit": p["sourceCommit"], "images": {role: row["Image"] for role, row in rows.items()},
            "engineHealthy": True, "ariConnected": True, "otherContainersPreserved": len(p["otherContainers"]),
            "neuroReady": not rollback, "newSelectionEnabled": active and not rollback, "databaseRetained": True}


def rollback(root, automatic=False):
    p = load(root)
    # Once admission might have opened, an old executable is never a safe
    # fallback: a concurrent valid save could race even a zero-row check.
    require(not (root / "activation-started.private.json").exists()
            and not (root / "activated.private.json").exists(), "ACTIVATED_RELEASE_REQUIRES_COMPATIBILITY_RECOVERY")
    idle()
    for role in ("crm", "worker"):
        row = inspect(NAMES[role])
        if row["Image"] == p["images"][role]:
            check_container(p, role, allow_unhealthy=True)
            require(envmap(row).get("NEURO_GEMINI_ENABLED") == "false", "ROLLBACK_ADMISSION_NOT_CLOSED")
        else:
            require(row["Image"] == p["before"][role]["Image"], "ROLLBACK_IMAGE_DRIFT")
    database = Path(p["database"])
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        selected = db.execute("SELECT COUNT(*) FROM instances WHERE voiceAiProvider='neuro_gemini'").fetchone()[0]
    require(selected == 0, "NEW_VOICE_SELECTIONS_REQUIRE_COMPATIBILITY_RECOVERY")
    current_hash = sha(p["liveConfig"])
    if current_hash == p["configAfterHash"]:
        idle()
        replace_config(p, root / "ai-agent.before.private.yaml", p["configAfterHash"])
    else:
        require(current_hash == p["configBeforeHash"], "ROLLBACK_CONFIG_DRIFT")
    for role in ("worker", "crm", "engine"):
        idle()
        up(p, role, root / (role + ".rollback.private.json"), rollback=True)
    receipt = verify(root, rollback=True)
    private_json(root / "rollback.private.json", receipt)
    print(json.dumps({"phase": "rolled_back", "automatic": automatic, **receipt}), flush=True)


def apply(root):
    p = load(root)
    guard_original(p)
    gate = json.loads((root / "migration-gate.json").read_text())
    require(gate.get("pass") is True and gate.get("sourceCommit") == p["sourceCommit"] and gate.get("candidateImage") == p["images"]["crm"], "DATABASE_COPY_GATE_MISSING")
    smoke = json.loads((root / "runtime-smoke.json").read_text())
    require(smoke.get("pass") is True and smoke.get("image") == p["images"]["engine"]
            and smoke.get("sourceCommit") == p["sourceCommit"], "PROVIDER_SMOKE_MISSING")
    idle()
    stage_admission(root, p)
    fresh = backup(Path(p["database"]), root / ("apply-crm-" + str(time.time_ns()) + ".db"))
    guard_original(p)
    private_json(root / "apply-started.private.json", {"backup": fresh, "sourceCommit": p["sourceCommit"], "time": time.time()})
    try:
        migrate_live(root, p)
        replace_config(p, p["stagedConfig"], p["configBeforeHash"])
        for role in ("engine", "worker", "crm"):
            idle()
            up(p, role, p["overrides"][role])
        receipt = verify(root)
        private_json(root / "applied.private.json", receipt)
        print(json.dumps({"phase": "applied_admission_closed", "backup": fresh, **receipt}), flush=True)
    except Exception as cause:
        code = str(cause)
        private_json(root / "apply-failure.private.json", {"code": code if re.fullmatch("[A-Z_]+", code) else type(cause).__name__,
                                                           "sourceCommit": p["sourceCommit"]})
        if (root / "last-command.private.log").exists():
            shutil.copy2(root / "last-command.private.log", root / "apply-error.private.log")
        try:
            rollback(root, automatic=True)
        except Exception:
            private_json(root / "recovery-required.private.json", {"sourceCommit": p["sourceCommit"], "databaseRetained": True})
            raise RuntimeError("APPLY_FAILED_RECOVERY_REQUIRED_DATABASE_RETAINED") from None
        raise RuntimeError("APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED") from None


def close_admission(root, p):
    # Keep the compatible candidate executable and customer selections. Never
    # restore old application images after an activation attempt.
    for role in ("crm", "worker"):
        idle()
        up(p, role, p["overrides"][role])
    receipt = verify(root)
    private_json(root / "admission-recovered.private.json", receipt)
    return receipt


def activate(root):
    p = load(root)
    require((root / "applied.private.json").is_file() and not (root / "activated.private.json").exists(), "ACTIVATION_STATE_INVALID")
    if (root / "activation-started.private.json").exists():
        close_admission(root, p)
    else:
        verify(root)
    idle()
    private_json(root / "activation-started.private.json", {"sourceCommit": p["sourceCommit"], "time": time.time()})
    try:
        for role in ("worker", "crm"):
            idle()
            up(p, role, p["activationOverrides"][role], active=True)
        receipt = verify(root, active=True)
    except Exception:
        try:
            close_admission(root, p)
        except Exception:
            raise RuntimeError("ACTIVATION_INCOMPLETE_COMPATIBLE_RECOVERY_REQUIRED") from None
        raise RuntimeError("ACTIVATION_FAILED_ADMISSION_CLOSED_CANDIDATE_RETAINED") from None
    private_json(root / "activated.private.json", receipt)
    print(json.dumps({"phase": "activated", **receipt}), flush=True)


LOG_ROOT = None
if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "apply", "activate", "verify", "rollback"])
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    LOG_ROOT = args.root
    try:
        operator_lock = (args.root / "operator.lock").open("a")
        try:
            fcntl.flock(operator_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("OPERATOR_ALREADY_RUNNING") from None
        if args.action == "verify":
            print(json.dumps(verify(args.root, active=(args.root / "activated.private.json").exists())))
        else:
            globals()[args.action](args.root)
    except Exception as exc:
        code = str(exc)
        code = code if code.isupper() and code.replace("_", "").isalnum() else "OPERATOR_FAILED_" + type(exc).__name__.upper()
        print(json.dumps({"phase": "failed", "code": code}), flush=True)
        raise SystemExit(1)
