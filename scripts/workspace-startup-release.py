#!/usr/bin/env python3
"""Pinned CRM asset overlay; retain existing assets, backend, workers and voice."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time

PINS = {"engine": "sha256:d4cb2a4490db4f62e13d859064a75ecc9a65e23a58a6696dc9903de13f881a01",
        "crm": "sha256:52a187f36b2957c65ab585459632e8d977d50b1a5cfdbd6dd6be25bcd0cf3006",
        "worker": "sha256:db4e83065fd6887a363de411c7d06b2b3178ffc6f497c79df3313e23e83997e7"}
SELECTED = ("crm",)
CRM = ()  # Bound to the manifest asset inventory by main().
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
    require(role in SELECTED, "ROLE_OUTSIDE_SCOPE")
    return {p: p for p in CRM}


def file_hashes(core, container, names=None):
    script = r"""const fs=require('fs'),p=require('path'),c=require('crypto'),out={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
const file=p.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('ASSET_SYMLINK');
if(entry.isDirectory())walk(file);else if(entry.isFile())out[p.relative('/app',file)]=c.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
else throw Error('ASSET_SPECIAL_FILE');}}walk('/app/frontend/dist');console.log(JSON.stringify(out));"""
    return json.loads(core.run(["docker", "exec", container, "node", "-e", script]))


def prepare(root, core, manifest_sha):
    require(not (root / "prepared.private.json").exists(), "ALREADY_PREPARED")
    manifest = root / "payload/manifest.json"
    require(digest(manifest) == manifest_sha, "MANIFEST_DRIFT")
    m = json.loads(manifest.read_text())
    require(set(m["files"]) == set(CRM), "SCOPE_DRIFT")
    before = {role: core.inspect(name) for role, name in core.NAMES.items()}
    require(all(row["Image"] == PINS[role] for role, row in before.items()), "LIVE_IMAGE_DRIFT")
    p = {"before": before, "images": {}, "intended": {}, "inputs": {}, "manifestSha": manifest_sha,
         "otherContainers": core.other_containers(), "overrides": {}, "rollback": {}}
    for role in SELECTED:
        row = before[role]
        require(file_hashes(core, core.NAMES[role]) == m["beforeFiles"], "EXACT_ASSET_PREIMAGE_DRIFT")
        for source in paths(role):
            require(digest(root / "payload" / source) == m["files"][source]["after"], "PAYLOAD_DRIFT")
            if source in m["beforeFiles"] and source != "frontend/dist/index.html":
                require(m["beforeFiles"][source] == m["files"][source]["after"], "ASSET_CONTENT_COLLISION")
        context = root / (role + "-build")
        context.mkdir()
        base_tag = "ava-workspace-startup-base:" + manifest_sha[:12]
        core.run(["docker", "tag", row["Image"], base_tag])
        shutil.copytree(root / "payload/frontend/dist", context / "dist")
        for path in [context / "dist", *(context / "dist").rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
        dockerfile = ["FROM " + base_tag, 'COPY ["dist/", "/app/frontend/dist/"]']
        (context / "Dockerfile").write_text("\n".join(dockerfile) + "\n")
        tag = "ava-workspace-startup-" + role + ":" + manifest_sha[:12]
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

def apply(root, core):
    p = json.loads((root / "prepared.private.json").read_text())
    require(digest(root / "payload/manifest.json") == p["manifestSha"], "PREPARED_MANIFEST_DRIFT")
    require(not (root / "apply-started").exists(), "APPLY_ALREADY_ATTEMPTED")
    require(all(core.inspect(core.NAMES[role])["Id"] == row["Id"] for role, row in p["before"].items()), "CONTAINER_DRIFT")
    require(core.other_containers() == p["otherContainers"], "OTHER_CONTAINER_DRIFT")
    require(all(digest(path) == value for path, value in p["inputs"].items()), "INPUT_DRIFT")
    core.idle()
    backup_path = "/tmp/ava-workspace-startup-crm-backup.db"
    core.run(["docker", "exec", "whatsapp_crm", "node", "-e", BACKUP, backup_path])
    core.run(["docker", "cp", "whatsapp_crm:" + backup_path, str(root / "crm-backup.db")])
    (root / "crm-backup.db").chmod(0o600)
    engine_data = next(m["Source"] for m in p["before"]["engine"]["Mounts"] if m["Destination"] == "/app/data")
    core.backup(Path(engine_data) / "call_history.db", root / "calls-backup.db")
    (root / "apply-started").write_text(str(time.time()))
    changed = []
    try:
        for role in SELECTED:
            core.idle()
            changed.append(role)
            core.up(p, role, Path(p["overrides"][role]))
        for role in changed:
            core.check_container(p, role)
            m = json.loads((root / "payload/manifest.json").read_text())
            require(file_hashes(core, core.NAMES[role]) == {**m["beforeFiles"], **{source: value["after"] for source, value in m["files"].items()}}, "INSTALLED_ASSET_DRIFT")
        require(all(core.inspect(core.NAMES[role])["Id"] == p["before"][role]["Id"] for role in ("engine", "worker")), "UNSELECTED_SERVICE_CHANGED")
        require(core.other_containers() == p["otherContainers"], "OTHER_CONTAINER_DRIFT")
        require(all(digest(path) == value for path, value in p["inputs"].items()), "CONFIGURATION_DRIFT")
        core.private_json(root / "applied.private.json", {"images": p["images"], "manifestSha": p["manifestSha"], "dbRestored": False})
        print(json.dumps({"phase": "applied", "images": p["images"], "backupSha": digest(root / "crm-backup.db")}), flush=True)
    except BaseException:
        for role in reversed(changed):
            core.up(p, role, Path(p["rollback"][role]), rollback=True)
        raise


def rollback(root, core):
    p = json.loads((root / "prepared.private.json").read_text())
    require((root / "applied.private.json").exists(), "APPLIED_RECEIPT_REQUIRED")
    for role in SELECTED:
        core.check_container(p, role)
    require(all(digest(path) == value for path, value in p["inputs"].items()), "INPUT_DRIFT")
    core.idle()
    for role in reversed(SELECTED):
        core.idle()
        core.up(p, role, Path(p["rollback"][role]), rollback=True)
    core.private_json(root / "rolled-back.private.json", {"dbRestored": False})
    print(json.dumps({"phase": "rolled_back", "dbRestored": False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "apply", "rollback"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest-sha", required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    global CRM
    manifest = json.loads((root / "payload/manifest.json").read_text())
    CRM = tuple(manifest["files"])
    require(CRM and "frontend/dist/index.html" in CRM and all(
        name.startswith("frontend/dist/") and ".." not in name.split("/")
        and "\\" not in name and "\n" not in name for name in CRM), "ASSET_SCOPE_INVALID")
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
