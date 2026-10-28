#!/usr/bin/env python3
"""Build fenced local-image overlays, verify as app UID, then one synthetic turn."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("source_archive", Path(__file__).with_name("archive.py"))
archiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archiver)


def call(command, timeout=40):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("ISOLATED_IMAGE_CHECK_FAILED")
    return result.stdout


def main(root):
    os.umask(0o077)
    engine = root / "engine-0882143-b4"
    crm = root / "crm-0882143-b4"
    for target, source in ((engine, "neuro-engine-0882143-b4.tar.gz"), (crm, "neuro-crm-0882143-b4.tar.gz")):
        if target.is_symlink():
            raise RuntimeError("UNSUPPORTED_REUSED_CONTEXT_ENTRY")
        if not target.exists():
            archiver.unpack(root / source, target)
        if not target.is_dir():
            raise RuntimeError("UNSUPPORTED_REUSED_CONTEXT_ENTRY")
        target.chmod(0o755)
        # Also normalize a retained context from an earlier failed attempt.
        # Merely skipping extraction must not retain an obsolete private umask.
        for path in target.rglob("*"):
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise RuntimeError("UNSUPPORTED_REUSED_CONTEXT_ENTRY")
            path.chmod(0o755 if path.is_dir() else 0o644)
    engine_manifest = json.loads((engine / "manifest.json").read_text())
    crm_manifest = json.loads((crm / "manifest.json").read_text())
    images = {}
    for role, context, manifest in (("engine", engine, engine_manifest), ("crm", crm / "crm", crm_manifest["services"]["crm"]),
                                     ("worker", crm / "worker", crm_manifest["services"]["worker"])):
        names = list(manifest["baseFiles"])
        if role == "engine":
            code = 'import pathlib,hashlib,json;root=pathlib.Path("/app");names=' + repr(names) + ';print(json.dumps({n:hashlib.sha256((root/n).read_bytes()).hexdigest() if (root/n).is_file() else None for n in names}))'
            command = ["python", "-c", code]
        else:
            code = 'const fs=require("fs"),c=require("crypto"),out={};for(const n of ' + json.dumps(names) + '){let p="/app/"+n;out[n]=fs.existsSync(p)?c.createHash("sha256").update(fs.readFileSync(p)).digest("hex"):null;}console.log(JSON.stringify(out))'
            command = ["node", "-e", code]
        actual = json.loads(call(["docker", "run", "--rm", "--network", "none", "--entrypoint", command[0], manifest["baseImage"], *command[1:]]))
        if actual != manifest["baseFiles"]:
            raise RuntimeError("BASE_SOURCE_FENCE_FAILED")
        for name, expected in manifest["files"].items():
            path = context / "payload" / name
            if role == "crm" and name.startswith("frontend/dist/"):
                path = context / "frontend" / name.removeprefix("frontend/dist/")
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise RuntimeError("PAYLOAD_CHANGED")
        call(["docker", "tag", manifest["baseImage"], manifest["baseTag"]])
        base = json.loads(call(["docker", "image", "inspect", manifest["baseTag"]]))[0]
        if base["Id"] != manifest["baseImage"]:
            raise RuntimeError("BASE_TAG_DRIFT")
        with (root / (role + "-build-b4.private.log")).open("w") as log:
            result = subprocess.run(["docker", "build", "--pull=false", "--network", "host", "--iidfile", str(root / (role + ".image")),
                                     "-t", "ava-neuro-" + role + ":0882143", str(context)], stdout=log, stderr=subprocess.STDOUT, timeout=300)
        if result.returncode:
            raise RuntimeError("IMAGE_BUILD_FAILED_" + role.upper())
        image = (root / (role + ".image")).read_text().strip()
        row = json.loads(call(["docker", "image", "inspect", image]))[0]
        layers = base["RootFS"]["Layers"]
        if row["RootFS"]["Layers"][:len(layers)] != layers:
            raise RuntimeError("BASE_LAYERS_CHANGED")
        # Same code as baseline fence, now check all selected files as app UID.
        names = list(manifest["files"])
        if role == "engine":
            code = 'import pathlib,hashlib,json;root=pathlib.Path("/app");names=' + repr(names) + ';print(json.dumps({n:hashlib.sha256((root/n).read_bytes()).hexdigest() if (root/n).is_file() else None for n in names}))'
        else:
            code = 'const fs=require("fs"),c=require("crypto"),out={};for(const n of ' + json.dumps(names) + '){let p="/app/"+n;out[n]=fs.existsSync(p)?c.createHash("sha256").update(fs.readFileSync(p)).digest("hex"):null;}console.log(JSON.stringify(out))'
        interpreter = "python" if role == "engine" else "node"
        actual = json.loads(call(["docker", "run", "--rm", "--network", "none", "--entrypoint", interpreter, image, "-c" if role == "engine" else "-e", code]))
        if actual != manifest["files"]:
            raise RuntimeError("APP_UID_CANNOT_READ_PINNED_SOURCE")
        if role == "crm":
            migration_readable = json.loads(call(["docker", "run", "--rm", "--network", "none", "--user", "1000:986",
                "--entrypoint", interpreter, image, "-e", code]))
            if migration_readable != manifest["files"]:
                raise RuntimeError("MIGRATION_UID_CANNOT_READ_PINNED_SOURCE")
        images[role] = image
        print(json.dumps({"phase": "image_verified", "role": role, "image": image, "selectedFiles": len(names), "baseLayersPreserved": True}), flush=True)
    (root / "images.json").write_text(json.dumps(images, indent=2) + "\n")
    code = 'import json,importlib.metadata,importlib.util;from src.providers.neuro_gemini import NeuroGeminiProvider;assert importlib.util.find_spec("pip") is None;print(json.dumps({x:importlib.metadata.version(x) for x in ["google-auth","requests","jsonschema","jsonschema-specifications","referencing","rpds-py","aiohttp"]}))'
    packages = json.loads(call(["docker", "run", "--rm", "--network", "none", "--entrypoint", "python", images["engine"], "-c", code]))
    for role in ("crm", "worker"):
        call(["docker", "run", "--rm", "--network", "none", "--entrypoint", "node", images[role], "-e", "require('/app/src/services/voice-options.service');require('/app/src/services/voice-settings.service');require('/app/src/routes/voice-settings.routes');console.log('imports_ok')"])
    print(json.dumps({"phase": "imports_verified", "packages": packages, "pipAbsentFromRuntime": True}), flush=True)
    result = subprocess.run(["docker", "run", "--rm", "--network", "host", "--env-file", "/root/ava-private/neuro-gemini-20261014/voice.env",
                             "--mount", "type=bind,src=/root/ava-private/neuro-gemini-20261014/vertex-adc.json,dst=/run/secrets/ava-vertex-adc.json,readonly",
                             "-e", "PYTHONPATH=/app", "--entrypoint", "python", images["engine"], "/app/neuro-runtime-smoke.py"],
                            capture_output=True, text=True, timeout=105)
    (root / "runtime-smoke.stdout.private.log").write_text(result.stdout)
    (root / "runtime-smoke.stderr.private.log").write_text(result.stderr)
    receipt = json.loads(result.stdout)
    receipt.update(image=images["engine"], sourceCommit=engine_manifest["candidateCommit"], host="production_host_isolated_candidate", packages=packages)
    (root / "runtime-smoke.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)
    if result.returncode or not receipt.get("pass"):
        raise RuntimeError("SYNTHETIC_PROVIDER_CHECK_FAILED")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    main(parser.parse_args().root)
