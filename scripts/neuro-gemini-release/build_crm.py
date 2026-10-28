#!/usr/bin/env python3
"""Build pinned CRM/worker overlay contexts while retaining prod-only source."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).parents[1] / "ava-registration-release/build_bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--frontend-dist", type=Path, required=True)
    parser.add_argument("--frontend-receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--worker-base-file-commit", action="append", default=[])
    args = parser.parse_args()
    for sha in (args.base, args.candidate):
        bundle.validate_commit(args.repo, sha)
    bundle.git(args.repo, "merge-base", "--is-ancestor", args.base, args.candidate)
    bundle.require(not args.output.exists(), "OUTPUT_EXISTS")
    build = json.loads(args.frontend_receipt.read_text())
    bundle.require(build["sourceCommit"] == args.candidate, "FRONTEND_COMMIT_MISMATCH")
    inventory = json.loads(args.inventory.read_text())
    selected = bundle.runtime_changes(args.repo, args.base, args.candidate, True)
    # Acceptance tests are supplied as isolated verification mounts, not runtime.
    selected = [p for p in selected if p.startswith("src/") or p in ("server.js", "provisioning-worker.js")]
    sources = {p: bundle.blob(args.repo, args.candidate, "whatsapp_crm/" + p) for p in selected}
    frontend_bytes = bundle.frontend_artifact(args.frontend_dist, build["files"])
    actual_frontend = {path: bundle.sha(content) for path, content in frontend_bytes.items()}
    manifest = {"baseCommit": args.base, "candidateCommit": args.candidate, "services": {}}
    for service, name in (("crm", "whatsapp_crm"), ("worker", "asterisk-ai-voice-agent-provisioning_worker-1")):
        origins = bundle.file_commit_overrides(args.repo, args.worker_base_file_commit if service == 'worker' else [], selected)
        before = inventory[name]
        bundle.require(re.fullmatch(r"sha256:[0-9a-f]{64}", before["image"]), "PINNED_BASE_IMAGE_REQUIRED")
        context = args.output / service
        fences, hashes = {}, {}
        for path, content in sources.items():
            old = bundle.blob(args.repo, origins.get(path, args.base), "whatsapp_crm/" + path, optional=True)
            expected = bundle.sha(old) if old is not None else None
            bundle.require(before["sourceHashes"].get(path) == expected, "PRODUCTION_SOURCE_DRIFT:" + path)
            fences[path] = expected
            target = context / "payload" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            hashes[path] = bundle.sha(content)
        base_tag = "ava-neuro-base-" + service + ":" + before["image"].removeprefix("sha256:")
        # The pinned worker runs as1000:986 and its /app mode is0700. COPY's
        # root ownership would make that entire tree unreadable to the worker.
        copy = "COPY --chown=1000:986 payload/ /app/" if service == "worker" else "COPY payload/ /app/"
        dockerfile = f"FROM {base_tag}\n{copy}\n"
        if service == "crm":
            for path, content in frontend_bytes.items():
                target = context / "frontend" / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            dockerfile += "COPY frontend/ /app/frontend/dist/\n"
            # COPY may retain directory metadata from cached overlay parents.
            # Source must also be readable by the isolated migration UID.
            dockerfile += "RUN find /app/src /app/frontend/dist -type d -exec chmod 0755 {} +\n"
            hashes.update({"frontend/dist/" + p: sha for p, sha in actual_frontend.items()})
        dockerfile += f"LABEL org.opencontainers.image.revision={args.candidate}\n"
        (context / "Dockerfile").write_text(dockerfile)
        manifest["services"][service] = {"container": name, "baseImage": before["image"], "baseTag": base_tag,
                "baseFiles": fences, "baseFileCommits": origins, "files": hashes, "preserveUnselectedProductionFiles": True}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"candidate": args.candidate, "selectedRuntimeFiles": len(selected),
                      "newFrontendFiles": len(actual_frontend), "output": str(args.output)}))


if __name__ == "__main__":
    main()
