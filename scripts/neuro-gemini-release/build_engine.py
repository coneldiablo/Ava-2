#!/usr/bin/env python3
"""Assemble an immutable, source-fenced overlay on the current production image.

Does not execute Docker, SSH, pip, the engine or provider requests. Production
source exceptions outside selected files remain in the pinned base image.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def git(repo, *args, optional=False):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if optional and result.returncode:
        return None
    require(result.returncode == 0, "GIT_FAILED")
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular_blob(repo, ref, path, optional=False):
    tree = git(repo, "ls-tree", "-z", ref, "--", path)
    if not tree:
        require(optional, "GIT_SOURCE_MISSING")
        return None
    records = tree.rstrip(b"\0").split(b"\0")
    require(len(records) == 1, "GIT_SOURCE_AMBIGUOUS")
    metadata, name = records[0].split(b"\t", 1)
    mode, kind, oid = metadata.split()
    require(name.decode() == path and mode in (b"100644", b"100755") and kind == b"blob", "REGULAR_GIT_BLOB_REQUIRED")
    return git(repo, "cat-file", "blob", oid.decode())


def selected_payload(repo, base, candidate, inventory):
    require(re.fullmatch(r"[0-9a-f]{40}", base), "BASE_SHA_REQUIRED")
    require(re.fullmatch(r"[0-9a-f]{40}", candidate), "CANDIDATE_SHA_REQUIRED")
    git(repo, "merge-base", "--is-ancestor", base, candidate)
    fields = git(repo, "diff", "--name-status", "--no-renames", "-z", base, candidate, "--", "src").split(b"\0")
    payload, fences = {}, {}
    for index in range(0, len(fields) - 1, 2):
        status, raw_path = fields[index:index + 2]
        path = raw_path.decode("utf-8")
        require(status in (b"A", b"M"), "DELETION_OR_TYPE_CHANGE")
        require(path.startswith("src/") and path.endswith(".py") and
                all(part not in ("", ".", "..") for part in path.split("/")) and
                "\\" not in path, "UNSUPPORTED_ENGINE_PATH")
        before = regular_blob(repo, base, path, optional=True)
        expected = digest(before) if before is not None else None
        require(inventory.get(path) == expected, "PRODUCTION_SOURCE_DRIFT:" + path)
        fences[path] = expected
        payload[path] = regular_blob(repo, candidate, path)
    require(payload, "EMPTY_ENGINE_OVERLAY")
    return payload, fences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--base-user", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), "OUTPUT_EXISTS")
    require(re.fullmatch(r"[A-Za-z0-9_.:-]+", args.base_user), "INVALID_IMAGE_USER")
    before = json.loads(args.inventory.read_text())["ai_engine"]
    image = before["image"]
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", image), "PINNED_BASE_IMAGE_REQUIRED")
    payload, fences = selected_payload(args.repo, args.base, args.candidate, before["sourceHashes"])
    smoke = regular_blob(args.repo, args.candidate, "docs/neuro-gemini/runtime-smoke.py")
    args.output.mkdir(parents=True)
    for path, content in payload.items():
        target = args.output / "payload" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (args.output / "runtime-smoke.py").write_bytes(smoke)
    # Existing requests/google-auth are verified separately; install only the new
    # validated tool-schema dependency. Its resolved transitive versions are
    # recorded by the final image check before this image may be installed.
    base_tag = "ava-neuro-base-engine:" + image.removeprefix("sha256:")
    dockerfile = f"""FROM {base_tag}
USER root
RUN /usr/local/bin/python -m venv /tmp/ava-dependency-tools \
    && /tmp/ava-dependency-tools/bin/python -m pip --python /opt/venv/bin/python install --no-cache-dir 'jsonschema==4.25.1' 'jsonschema-specifications==2025.9.1' 'referencing==0.37.0' 'rpds-py==2026.9.1' \
    && rm -rf /tmp/ava-dependency-tools
COPY payload/src/ /app/src/
COPY runtime-smoke.py /app/neuro-runtime-smoke.py
LABEL org.opencontainers.image.revision={args.candidate}
USER {args.base_user}
"""
    (args.output / "Dockerfile").write_text(dockerfile)
    manifest = {"baseCommit": args.base, "candidateCommit": args.candidate,
                "baseImage": image, "baseTag": base_tag, "baseUser": args.base_user,
                "baseFiles": fences,
                "files": {path: digest(content) for path, content in payload.items()},
                "smokeSha256": digest(smoke), "newDependency": "jsonschema==4.25.1",
                "preserveUnselectedProductionFiles": True}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"candidate": args.candidate, "baseImage": image,
                      "selectedFiles": len(payload), "output": str(args.output)}))


if __name__ == "__main__":
    main()
