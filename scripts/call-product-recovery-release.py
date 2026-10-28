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

PINS = {"engine": "sha256:933d8991755e45872190a2f3823d49eff834d146a9b5c853bbfbb3b795203a88",
        "crm": "sha256:e2a7ed118097ab38e6df13d1c9f87d2329f20bb69b4ee0abc69be4319f998924",
        "worker": "sha256:e557a683f322f3e91100b262ed20f72ec45f1b724877b0d89772496a4859229b"}
ENGINE = ("src/engine.py", "src/core/voice_closing.py", "src/core/voice_channel_policy.py", "src/providers/neuro_gemini.py", "src/providers/yandex_realtime.py", "src/tools/telephony/hangup.py")
CRM = ()  # Filled from the final reviewed manifest by the packaging step.
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
    if role == "engine":
        return {p: p for p in ENGINE}
    return {p: p.removeprefix("whatsapp_crm/") for p in CRM
            if role == "crm" or p.startswith("whatsapp_crm/src/")}


def instagram_dependency(root, manifest, role, context):
    """Install one reviewed pure Python wheel into the existing isolated venv."""
    dependency = manifest.get("instagramDependency")
    if not dependency or role != "crm":
        return []
    require(manifest.get("roles") == ["crm"], "DEPENDENCY_ROLE_SCOPE")
    require(dependency.get("version") == "3.0.21"
            and dependency.get("sourceCommit") == "3f0b4369753fc69d98cd2bc853146cc85d3b1635"
            and dependency.get("wheel") == "dependencies/instagrapi-3.0.21-py3-none-any.whl",
            "DEPENDENCY_SCOPE_DRIFT")
    source = root / dependency["wheel"]
    require(digest(source) == dependency["sha256"], "DEPENDENCY_WHEEL_DRIFT")
    shutil.copyfile(source, context / "instagrapi.whl")
    return ['COPY ["instagrapi.whl", "/tmp/instagrapi-3.0.21-py3-none-any.whl"]',
            'RUN /opt/ava-instagram-private/bin/python3 -m pip install --no-index --no-deps --no-cache-dir '
            '/tmp/instagrapi-3.0.21-py3-none-any.whl && '
            '/opt/ava-instagram-private/bin/python3 -m pip check && '
            'rm /tmp/instagrapi-3.0.21-py3-none-any.whl']


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
    require(set(m["files"]) == set(ENGINE) | set(CRM), "SCOPE_DRIFT")
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
        base_tag = "ava-call-recovery-base-" + role + ":20261023"
        core.run(["docker", "tag", row["Image"], base_tag])
        dockerfile = ["FROM " + base_tag]
        # Overlay the reviewed files in one layer. Historical release images
        # already contain many layers; one COPY per frontend asset can exceed
        # the storage driver's lower-directory mount limit.
        for source, dest in paths(role).items():
            target = context / "rootfs" / dest
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / "payload" / source, target)
            target.chmod(0o644)
        dockerfile.append('COPY ["rootfs/", "/app/"]')
        dockerfile.extend(instagram_dependency(root, m, role, context))
        (context / "Dockerfile").write_text("\n".join(dockerfile) + "\n")
        tag = "ava-call-recovery-" + role + ":" + manifest_sha[:12]
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
    for mount in (before.get("engine") or core.inspect("ai_engine"))["Mounts"]:
        if mount["Destination"] == "/app/config":
            for path in Path(mount["Source"]).rglob("*"):
                if path.is_file():
                    p["inputs"][str(path)] = digest(path)
    for role in core.NAMES:
        if role == "engine":
            command = ["python", "-c", "import src.engine, src.core.voice_closing, src.providers.neuro_gemini, src.providers.yandex_realtime, src.tools.telephony.hangup;print('ok')"]
        else:
            command = ["node", "-e", "require('/app/src/services/sales-brain.service');require('/app/src/services/postcall-followup.service');require('/app/src/services/openwa.service');require('/app/src/services/whatsapp-media.service');require('/app/src/routes/customer-pms.routes');require('/app/src/services/telephony/campaigns');console.log('ok')"]
        core.run(["docker", "run", "--rm", "--network=none", "--read-only", "--tmpfs", "/tmp", "--env-file", str(root / (role + ".private.env")), "-e", "PYTHONDONTWRITEBYTECODE=1", "--entrypoint", command[0], p["images"][role], *command[1:]], timeout=90)
    p["offlineImportsVerified"] = True
    core.private_json(root / "prepared.private.json", p)
    print(json.dumps({"phase": "prepared", "images": p["images"], "manifestSha": manifest_sha}), flush=True)


BACKUP = r'''const S=require('/app/node_modules/better-sqlite3'),vec=require('/app/node_modules/sqlite-vec');
(async()=>{const db=new S(process.env.DB_PATH,{readonly:true,fileMustExist:true});vec.load(db);
await db.backup(process.argv[1]);db.close();const copy=new S(process.argv[1],{readonly:true});vec.load(copy);
if(copy.pragma('integrity_check',{simple:true})!=='ok')throw Error('BACKUP_INTEGRITY');copy.close();console.log('ok');})();'''


def apply(root, core):
    p = json.loads((root / "prepared.private.json").read_text())
    require(digest(root / "payload/manifest.json") == p["manifestSha"], "PREPARED_MANIFEST_DRIFT")
    require(not (root / "apply-started").exists(), "APPLY_ALREADY_ATTEMPTED")
    require(all(core.inspect(core.NAMES[role])["Id"] == row["Id"] for role, row in p["before"].items()), "CONTAINER_DRIFT")
    require(core.other_containers() == p["otherContainers"], "OTHER_CONTAINER_DRIFT")
    require(all(digest(path) == value for path, value in p["inputs"].items()), "INPUT_DRIFT")
    core.idle()
    backup_path = "/tmp/ava-call-recovery-crm-backup.db"
    core.run(["docker", "exec", "whatsapp_crm", "node", "-e", BACKUP, backup_path])
    core.run(["docker", "cp", "whatsapp_crm:" + backup_path, str(root / "crm-backup.db")])
    (root / "crm-backup.db").chmod(0o600)
    engine_row = p["before"].get("engine") or core.inspect("ai_engine")
    engine_data = next(m["Source"] for m in engine_row["Mounts"] if m["Destination"] == "/app/data")
    core.backup(Path(engine_data) / "call_history.db", root / "calls-backup.db")
    (root / "apply-started").write_text(str(time.time()))
    changed, rows = [], []
    try:
        for role in (name for name in ("worker", "crm", "engine") if name in p["before"]):
            core.idle()
            changed.append(role)
            core.up(p, role, Path(p["overrides"][role]))
        for role in changed:
            core.check_container(p, role)
            m = json.loads((root / "payload/manifest.json").read_text())
            require(file_hashes(core, core.NAMES[role], paths(role).values()) == {dest: m["files"][source]["after"] for source, dest in paths(role).items()}, "INSTALLED_SOURCE_DRIFT")
        require(core.other_containers() == p["otherContainers"], "OTHER_CONTAINER_DRIFT")
        require(all(digest(path) == value for path, value in p["inputs"].items()), "CONFIGURATION_DRIFT")
        core.private_json(root / "applied.private.json", {"images": p["images"], "businessCount": len(rows), "manifestSha": p["manifestSha"], "dbRestored": False})
        print(json.dumps({"phase": "applied", "images": p["images"], "businessCount": len(rows), "backupSha": digest(root / "crm-backup.db")}), flush=True)
    except BaseException:
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
    for role in (name for name in ("engine", "crm", "worker") if name in p["before"]):
        core.idle()
        core.up(p, role, Path(p["rollback"][role]), rollback=True)
    core.private_json(root / "rolled-back.private.json", {"dbRestored": False, "profileSettingsUnchanged": True})
    print(json.dumps({"phase": "rolled_back", "dbRestored": False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "rollback"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest-sha", required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    global CRM, ENGINE, PINS
    manifest = json.loads((root / "payload/manifest.json").read_text())
    CRM = tuple(manifest["crmFiles"])
    ENGINE = tuple(manifest.get("engineFiles", ENGINE))
    core = module(root / "core.py")
    if "roles" in manifest:
        require(set(manifest["roles"]) <= set(core.NAMES) and bool(manifest["roles"]), "ROLE_SCOPE_INVALID")
        core.NAMES = {name: core.NAMES[name] for name in manifest["roles"]}
        require(set(manifest["baseImages"]) == set(core.NAMES), "BASE_SCOPE_INVALID")
        PINS = manifest["baseImages"]
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
