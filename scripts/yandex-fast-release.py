#!/usr/bin/env python3
"""Narrow image overlay release; preserve production-only code, config and data."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time

PINS = {"engine": "sha256:4b90a65a6fa34c60c6f2db33f004d088852234bd27e4b80890cc9c440894e28e",
        "crm": "sha256:7f7dae94862b8dd537dd2081e78398f706191215aef8322195e2246ca268c992",
        "worker": "sha256:72c33cd20f18d8f1053b131976ecfb3392689ec4f6a3b20dd2d8da36616bfde6"}
ENGINE = ("src/config.py", "src/providers/neuro_gemini.py", "src/providers/yandex_realtime.py", "src/providers/yandex_fast.py")
CRM = "whatsapp_crm/src/services/voice-options.service.js"
CORE_SHA = "1f8e0e2845d15bd504f4d33550545b9734b0bd83361f57d3ec8d2568d375015d"


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def module(path):
    require(digest(path) == CORE_SHA, "OPERATOR_DRIFT")
    spec = importlib.util.spec_from_file_location("reviewed_core", path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def paths(role):
    return {p: p for p in ENGINE} if role == "engine" else {CRM: CRM.removeprefix("whatsapp_crm/")}


def file_hashes(core, container, names):
    if container == "ai_engine":
        script = "import pathlib,json,hashlib;print(json.dumps({p:hashlib.sha256(pathlib.Path('/app',p).read_bytes()).hexdigest() if pathlib.Path('/app',p).is_file() else None for p in " + repr(list(names)) + "}))"
        return json.loads(core.run(["docker", "exec", container, "python", "-c", script]))
    script = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(" + json.dumps(list(names)) + ".map(p=>[p,fs.existsSync('/app/'+p)?c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex'):null]))));"
    return json.loads(core.run(["docker", "exec", container, "node", "-e", script]))


def prepare(root, core, manifest_sha):
    require(not (root / "prepared.private.json").exists(), "ALREADY_PREPARED")
    manifest = root / "payload/manifest.json"
    require(digest(manifest) == manifest_sha, "MANIFEST_DRIFT")
    m = json.loads(manifest.read_text())
    require(set(m["files"]) == set(ENGINE) | {CRM}, "SCOPE_DRIFT")
    before = {role: core.inspect(name) for role, name in core.NAMES.items()}
    require(all(row["Image"] == PINS[role] for role, row in before.items()), "LIVE_IMAGE_DRIFT")
    p = {"before": before, "images": {}, "intended": {}, "inputs": {}, "manifestSha": manifest_sha,
         "otherContainers": core.other_containers(), "overrides": {}, "rollback": {}}
    for role, row in before.items():
        expected = {dest: m["files"][source]["before"] for source, dest in paths(role).items()}
        require(file_hashes(core, core.NAMES[role], expected) == expected, "EXACT_PREIMAGE_DRIFT_" + role.upper())
        for source in paths(role):
            require(digest(root / "payload" / source) == m["files"][source]["after"], "PAYLOAD_DRIFT")
        context = root / (role + "-build")
        context.mkdir()
        base_tag = "ava-yandex-fast-base-" + role + ":20261020"
        core.run(["docker", "tag", row["Image"], base_tag])
        dockerfile = ["FROM " + base_tag]
        for index, (source, dest) in enumerate(paths(role).items()):
            filename = str(index) + ".source"
            shutil.copyfile(root / "payload" / source, context / filename)
            dockerfile.append("COPY " + json.dumps([filename, "/app/" + dest]))
        (context / "Dockerfile").write_text("\n".join(dockerfile) + "\n")
        tag = "ava-yandex-fast-" + role + ":" + manifest_sha[:12]
        core.run(["docker", "build", "--pull=false", "--network=none", "-t", tag, str(context)], timeout=180)
        p["images"][role] = json.loads(core.run(["docker", "image", "inspect", tag]))[0]["Id"]
        core.private_env(root / (role + ".private.env"), core.envmap(row))
        service = row["Config"]["Labels"]["com.docker.compose.service"]
        baseline = core.rendered(row)
        for label in ("com.docker.compose.project.config_files", "com.docker.compose.project.environment_file"):
            for name in row["Config"]["Labels"].get(label, "").split(","):
                if name:
                    p["inputs"][name] = digest(name)
        for mode, image in (("candidate", p["images"][role]), ("rollback", row["Image"])):
            target = root / (role + "." + mode + ".private.json")
            core.private_json(target, {"services": {service: {"image": image, "environment": {k: v.replace("$", "$$") for k, v in core.envmap(row).items()}}}})
            rendered = core.rendered(row, target)
            require(rendered["environment"] == core.envmap(row), "ENVIRONMENT_DRIFT")
            require(core.mount_signature(rendered.get("volumes", [])) == core.mount_signature(row["Mounts"], live=True), "MOUNT_DRIFT")
            expected = dict(baseline, image=image, environment=core.envmap(row))
            require(rendered == expected, "COMPOSE_CONTRACT_DRIFT")
            p["inputs"][str(target)] = digest(target)
            if mode == "candidate":
                p["intended"][role] = rendered
                p["overrides"][role] = str(target)
            else:
                p["rollback"][role] = str(target)
    # Config is outside this release. Pin every mounted config file byte.
    for mount in before["engine"]["Mounts"]:
        if mount["Destination"] == "/app/config":
            for path in Path(mount["Source"]).rglob("*"):
                if path.is_file():
                    p["inputs"][str(path)] = digest(path)
    core.private_json(root / "prepared.private.json", p)
    print(json.dumps({"phase": "prepared", "images": p["images"], "manifestSha": manifest_sha}), flush=True)


BACKUP = r'''const S=require('/app/node_modules/better-sqlite3'),vec=require('/app/node_modules/sqlite-vec');
(async()=>{const db=new S(process.env.DB_PATH,{readonly:true,fileMustExist:true});vec.load(db);
await db.backup(process.argv[1]);db.close();const copy=new S(process.argv[1],{readonly:true});vec.load(copy);
if(copy.pragma('integrity_check',{simple:true})!=='ok')throw Error('BACKUP_INTEGRITY');copy.close();console.log('ok');})();'''

MIGRATE = r'''const S=require('/app/node_modules/better-sqlite3'),db=new S(process.env.DB_PATH,{fileMustExist:true});
const apply=process.argv[1]==='apply',prior=JSON.parse(process.argv[2]||'[]');
const result=db.transaction(()=>{if(!apply){for(const row of prior){const now=db.prepare('SELECT voiceModel,voiceSettings FROM instances WHERE id=?').get(row.id);
if(now.voiceModel==='aliceai-llm-flash'){if(now.voiceSettings!==row.afterSettings)throw Error('PROFILE_ROLLBACK_DRIFT');db.prepare('UPDATE instances SET voiceModel=?,voiceSettings=? WHERE id=?').run(row.voiceModel,row.voiceSettings,row.id);}}return [];}
const rows=db.prepare("SELECT id,voiceModel,voiceSettings FROM instances WHERE isActive=1 AND voiceAiProvider='yandex_realtime'").all();
for(const row of rows){if(row.voiceModel&&!['speech-realtime-max-tts-live/latest','aliceai-llm-flash'].includes(row.voiceModel))throw Error('MODEL_DRIFT');
let settings=JSON.parse(row.voiceSettings||'{}');if(!settings||Array.isArray(settings)||typeof settings!=='object')throw Error('SETTINGS_DRIFT');
settings.yandex_realtime={...(settings.yandex_realtime||{}),model:'aliceai-llm-flash'};row.afterSettings=JSON.stringify(settings);
db.prepare('UPDATE instances SET voiceModel=?,voiceSettings=? WHERE id=?').run('aliceai-llm-flash',row.afterSettings,row.id);}return rows;})();
console.log(JSON.stringify(result));db.close();'''


def apply(root, core):
    p = json.loads((root / "prepared.private.json").read_text())
    require(digest(root / "payload/manifest.json") == p["manifestSha"], "PREPARED_MANIFEST_DRIFT")
    require(not (root / "apply-started").exists(), "APPLY_ALREADY_ATTEMPTED")
    require(all(core.inspect(core.NAMES[role])["Id"] == row["Id"] for role, row in p["before"].items()), "CONTAINER_DRIFT")
    require(core.other_containers() == p["otherContainers"], "OTHER_CONTAINER_DRIFT")
    require(all(digest(path) == value for path, value in p["inputs"].items()), "INPUT_DRIFT")
    core.idle()
    backup_path = "/tmp/ava-yandex-fast-crm-backup.db"
    core.run(["docker", "exec", "whatsapp_crm", "node", "-e", BACKUP, backup_path])
    core.run(["docker", "cp", "whatsapp_crm:" + backup_path, str(root / "crm-backup.db")])
    (root / "crm-backup.db").chmod(0o600)
    engine_data = next(m["Source"] for m in p["before"]["engine"]["Mounts"] if m["Destination"] == "/app/data")
    core.backup(Path(engine_data) / "call_history.db", root / "calls-backup.db")
    (root / "apply-started").write_text(str(time.time()))
    changed, rows = [], []
    try:
        for role in ("worker", "crm", "engine"):
            core.idle()
            changed.append(role)
            core.up(p, role, Path(p["overrides"][role]))
        rows = json.loads(core.run(["docker", "exec", "whatsapp_crm", "node", "-e", MIGRATE, "apply"]))
        core.private_json(root / "profiles-before.private.json", rows)
        for role in changed:
            core.check_container(p, role)
            m = json.loads((root / "payload/manifest.json").read_text())
            require(file_hashes(core, core.NAMES[role], paths(role).values()) == {dest: m["files"][source]["after"] for source, dest in paths(role).items()}, "INSTALLED_SOURCE_DRIFT")
        require(core.other_containers() == p["otherContainers"], "OTHER_CONTAINER_DRIFT")
        require(all(digest(path) == value for path, value in p["inputs"].items()), "CONFIGURATION_DRIFT")
        core.private_json(root / "applied.private.json", {"images": p["images"], "businessCount": len(rows), "manifestSha": p["manifestSha"], "dbRestored": False})
        print(json.dumps({"phase": "applied", "images": p["images"], "businessCount": len(rows), "backupSha": digest(root / "crm-backup.db")}), flush=True)
    except BaseException:
        if rows:
            core.run(["docker", "exec", "whatsapp_crm", "node", "-e", MIGRATE, "rollback", json.dumps(rows)])
        for role in reversed(changed):
            core.up(p, role, Path(p["rollback"][role]), rollback=True)
        raise


def rollback(root, core):
    p = json.loads((root / "prepared.private.json").read_text())
    require((root / "applied.private.json").exists(), "APPLIED_RECEIPT_REQUIRED")
    for role in core.NAMES:
        core.check_container(p, role)
    require(all(digest(path) == value for path, value in p["inputs"].items()), "INPUT_DRIFT")
    core.idle()
    rows = json.loads((root / "profiles-before.private.json").read_text())
    core.run(["docker", "exec", "whatsapp_crm", "node", "-e", MIGRATE, "rollback", json.dumps(rows)])
    for role in ("engine", "crm", "worker"):
        core.idle()
        core.up(p, role, Path(p["rollback"][role]), rollback=True)
    core.private_json(root / "rolled-back.private.json", {"dbRestored": False, "profileFieldsRestoredWithCompareAndSwap": True})
    print(json.dumps({"phase": "rolled_back", "dbRestored": False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "rollback"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest-sha", required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    core = module(root / "core.py")
    core.LOG_ROOT = root
    require(digest(root / "payload/manifest.json") == args.manifest_sha, "MANIFEST_DRIFT")
    with open("/var/lock/ava-customer-path-release.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == "prepare":
            prepare(root, core, args.manifest_sha)
        elif args.mode == "apply":
            apply(root, core)
        else:
            rollback(root, core)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({"phase": "failed", "code": code if code.replace("_", "").isalnum() else type(error).__name__}), flush=True)
        raise SystemExit(1)
