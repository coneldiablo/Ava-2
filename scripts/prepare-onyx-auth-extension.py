#!/usr/bin/env python3
"""Prepare a pinned Community Onyx source tree with the AVA auth sidecar.

The input must be a tree produced by ``prepare-onyx-community-extension.py``.
This script copies only AVA-owned files into a new output tree; it never edits
an installed runtime and rejects a tree containing the Enterprise source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a1b9e02eb65cc114c65381cbef5e555e1753ed0a"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(source: Path, output: Path) -> dict:
    source, output = source.resolve(), output.resolve()
    if output.exists() or output.is_symlink() or not (source / "backend/onyx/auth/users.py").is_file():
        raise ValueError("SOURCE_OR_OUTPUT_INVALID")
    lock = json.loads((ROOT / "native_modules/upstreams.lock.json").read_text())["onyx"]
    if (lock["commit"] != COMMIT
            or digest(source / "backend/onyx/auth/users.py") != lock["files"]["backend/onyx/auth/users.py"]
            or digest(source / "backend/onyx/main.py") != lock["files"]["backend/onyx/main.py"]):
        raise ValueError("PINNED_COMMUNITY_SOURCE_REQUIRED")
    # Upstream's public tarball contains separately licensed EE directories.
    # Exclude them from the prepared image rather than copying or patching them.
    shutil.copytree(source, output, symlinks=True,
                    ignore=shutil.ignore_patterns("ee"))
    destination = output / "backend/onyx/ava_auth"
    shutil.copytree(ROOT / "native_modules/onyx/auth", destination)
    main = output / "backend/onyx/main.py"
    marker = "    setup_prometheus_metrics(application)\n"
    hook = marker + "\n    # AVA isolated native-auth image only; base Community remains unchanged.\n    from onyx.ava_auth.http_guard import install_native_http_guard\n    install_native_http_guard(application)\n"
    text = main.read_text()
    if text.count(marker) != 1:
        raise ValueError("PINNED_MAIN_HOOK_CONTEXT_CHANGED")
    main.write_text(text.replace(marker, hook, 1))
    manifest = {
        "upstream_tag": "v4.7.0", "upstream_commit": COMMIT,
        "community_only": True, "files": {
            str(path.relative_to(output)): digest(path)
            for path in sorted(destination.rglob("*.py"))
        },
        "startup_hook": "backend/onyx/main.py",
        "patched_files": {"backend/onyx/main.py": digest(main)},
        "native_strategy_required": "TenantAwareRedisStrategy or RefreshableDatabaseStrategy",
        "fixture_tests_passed": False, "native_runtime_proof_passed": False,
        "production_ready": False,
    }
    (output / "AVA_AUTH_EXTENSION_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        print(json.dumps(prepare(arguments.source, arguments.output), sort_keys=True))
    except (OSError, ValueError, shutil.Error):
        raise SystemExit("PINNED_ONYX_AUTH_EXTENSION_PREPARATION_FAILED")
