#!/usr/bin/env python3
"""Check candidate migration and old-image compatibility on private DB copies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def main(root):
    os.umask(0o077)
    prepared = json.loads((root / "prepared.private.json").read_text())
    source = Path(prepared["prepareBackup"]["path"])
    if hashlib.sha256(source.read_bytes()).hexdigest() != prepared["prepareBackup"]["sha256"]:
        raise RuntimeError("BACKUP_DRIFT")
    probe_source = root / "tooling/migration_probe.cjs"
    directory = root / ("migration-copy-" + str(time.time_ns()))
    directory.mkdir(mode=0o700)
    os.chown(directory, 1000, 986)
    probe = directory / "migration_probe.cjs"
    shutil.copyfile(probe_source, probe)
    probe.chmod(0o444)
    probe_hash = hashlib.sha256(probe.read_bytes()).hexdigest()
    upgraded = directory / "upgrade.db"
    shutil.copyfile(source, upgraded)
    upgraded.chmod(0o600)
    os.chown(upgraded, 1000, 986)

    def run(mode, image, path):
        if hashlib.sha256(probe.read_bytes()).hexdigest() != probe_hash:
            raise RuntimeError("MIGRATION_PROBE_DRIFT")
        result = subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", "1000:986",
            "--env-file", str(root / "crm-before.env"), "-e", "DB_PATH=/verify/" + path.name,
            "-e", "AVA_APP_ROOT=/app", "-e", "AVA_PROCESS_ROLE=provisioning-worker",
            "--mount", f"type=bind,src={directory},dst=/verify",
            "--mount", f"type=bind,src={probe},dst=/release/migration_probe.cjs,readonly",
            "--entrypoint", "node", image, "/release/migration_probe.cjs", mode],
            capture_output=True, text=True, timeout=120)
        (directory / (mode + ".private.log")).write_text(result.stdout + result.stderr)
        value = json.loads(result.stdout)
        if hashlib.sha256(probe.read_bytes()).hexdigest() != probe_hash:
            raise RuntimeError("MIGRATION_PROBE_DRIFT")
        if result.returncode or value.get("ok") is not True or value.get("mode") != mode \
                or value.get("initVerified") is not True or value.get("voiceColumnsVerified") is not True \
                or value.get("sourceReadableVerified") is not True \
                or value.get("exactDataFence") is not True or value.get("schemaPreserved") is not True \
                or value.get("existingRowsPreserved") is not True or value.get("vectors", {}).get("preserved") is not True:
            raise RuntimeError("DATABASE_COPY_GATE_FAILED_" + mode.upper())
        return value

    migrate = run("migrate", prepared["images"]["crm"], upgraded)
    compatible = directory / "compat.db"
    shutil.copyfile(upgraded, compatible)
    compatible.chmod(0o600)
    os.chown(compatible, 1000, 986)
    compat = run("compat", prepared["before"]["crm"]["Image"], compatible)
    receipt = {"pass": True, "sourceCommit": prepared["sourceCommit"], "candidateImage": prepared["images"]["crm"],
               "oldImage": prepared["before"]["crm"]["Image"], "backupSHA256": prepared["prepareBackup"]["sha256"],
               "probeSHA256": probe_hash, "migrate": migrate, "compat": compat,
               "liveDatabaseTouched": False, "network": "none"}
    temporary = root / "migration-gate.json.tmp"
    temporary.write_text(json.dumps(receipt, indent=2) + "\n")
    os.replace(temporary, root / "migration-gate.json")
    print(json.dumps(receipt))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    main(parser.parse_args().root)
