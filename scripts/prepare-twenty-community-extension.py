#!/usr/bin/env python3
"""Create a Community-only Twenty source overlay from the locked checkout.

The source checkout is read-only input. The resulting directory is new, keeps
Twenty's licence/notices, and needs its normal upstream build; it never alters
EE code, an installed image, or a running service.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def patch_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("UPSTREAM_PATCH_CONTEXT_CHANGED")
    return text.replace(old, new, 1)


def checked_source(source, pinned):
    if not source.is_dir() or (source / ".git").exists() is False:
        raise ValueError("PINNED_TWENTY_CHECKOUT_REQUIRED")
    commit = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"], check=True,
        capture_output=True, text=True).stdout.strip()
    if commit != pinned["commit"]:
        raise ValueError("TWENTY_COMMIT_MISMATCH")
    for name, expected in pinned["files"].items():
        if sha(source / name) != expected:
            raise ValueError("UPSTREAM_FILE_SHA_MISMATCH")


def prepare(source: Path, output: Path):
    pinned = json.loads((ROOT / "native_modules/upstreams.lock.json").read_text())["twenty"]
    checked_source(source, pinned)
    if output.exists() or output.is_symlink():
        raise ValueError("OUTPUT_MUST_NOT_EXIST")
    try:
        shutil.copytree(source, output, ignore=shutil.ignore_patterns(".git", "node_modules", "dist", ".nx", ".yarn"))
        server = output / "packages/twenty-server"
        extension = server / "src/ava-native"
        extension.mkdir(parents=True)
        for name in ("adapter.cjs", "install.cjs"):
            shutil.copyfile(ROOT / "native_modules/twenty" / name, extension / name)

        main = server / "src/main.ts"
        main.write_text(patch_once(
            main.read_text(),
            "import './instrument';\n",
            "import './instrument';\n\n// AVA Community extension: internal peer listener and fail-closed request guard.\nconst { install: installAvaNativeAdapter } = require('./ava-native/install.cjs');\n",
        ))
        main.write_text(patch_once(
            main.read_text(),
            "  generateFrontConfig();\n",
            "  // Install after Twenty's parsers so GraphQL auth mutations can be\n  // rejected, but it is re-positioned before native route handlers.\n  await installAvaNativeAdapter(app);\n\n  generateFrontConfig();\n",
        ))
        changed = [
            "packages/twenty-server/src/main.ts",
            "packages/twenty-server/src/ava-native/adapter.cjs",
            "packages/twenty-server/src/ava-native/install.cjs",
        ]
        manifest = {
            "upstream_commit": pinned["commit"], "upstream_tag": pinned["tag"],
            "changes": {name: sha(output / name) for name in changed},
            "commercial_files_modified": False, "native_login_verified": False,
            "production_ready": False,
            "build_note": "Use native_modules/twenty/Dockerfile for the immutable-image overlay; it copies and preloads the adapter without modifying Twenty source.",
        }
        (output / "AVA_EXTENSION_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return manifest
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.source, args.output), sort_keys=True))
    except (ValueError, OSError, subprocess.CalledProcessError):
        raise SystemExit("PINNED_TWENTY_EXTENSION_PREPARATION_FAILED")
