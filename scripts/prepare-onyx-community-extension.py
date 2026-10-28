#!/usr/bin/env python3
"""Produce a new pinned upstream tree with AVA-owned Community-only patches.

Does not modify an existing checkout, running container, license flag or ee file.
The exact upstream archive and all modified source files are checked first.
"""
import argparse
import hashlib
import json
import posixpath
import shutil
import tarfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def patch_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("UPSTREAM_PATCH_CONTEXT_CHANGED")
    return text.replace(old, new, 1)


def prepare(archive: Path, output: Path):
    pinned = json.loads((ROOT / "native_modules/upstreams.lock.json").read_text())["onyx"]
    if sha(archive) != pinned["archive_sha256"]:
        raise ValueError("UPSTREAM_ARCHIVE_SHA_MISMATCH")
    if output.exists() or output.is_symlink():
        raise ValueError("OUTPUT_MUST_NOT_EXIST")
    prefix = f'onyx-{pinned["commit"]}'
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != prefix:
                raise ValueError("UNSAFE_UPSTREAM_ARCHIVE")
            if member.issym() or member.islnk():
                # Preserve valid repo-relative links using tarfile's data filter;
                # never accept an external or escaping target.
                target = PurePosixPath(member.linkname)
                resolved = posixpath.normpath(posixpath.join(str(path.parent), str(target)) if member.issym() else str(target))
                if target.is_absolute() or not resolved.startswith(prefix + "/"):
                    raise ValueError("UNSAFE_UPSTREAM_LINK")
            elif not (member.isfile() or member.isdir()):
                raise ValueError("UNSAFE_UPSTREAM_MEMBER")
        output.mkdir(parents=True, mode=0o700)
        try:
            source.extractall(output, filter="data")
            tree = output / prefix
            for name, expected in pinned["files"].items():
                if sha(tree / name) != expected:
                    raise ValueError("UPSTREAM_FILE_SHA_MISMATCH")
            config = tree / "backend/onyx/configs/app_configs.py"
            text = config.read_text()
            text = patch_once(text, 'DOCUMENT_INDEX_NAME = "danswer_index"',
                'from onyx.ava_namespace import document_index_name, bucket_name, validate_runtime_storage\n'
                'validate_runtime_storage()\nDOCUMENT_INDEX_NAME = document_index_name()')
            text = patch_once(text, 'S3_FILE_STORE_BUCKET_NAME = (\n    os.environ.get("S3_FILE_STORE_BUCKET_NAME") or "onyx-file-store-bucket"\n)',
                'S3_FILE_STORE_BUCKET_NAME = bucket_name()')
            client = tree / "backend/onyx/document_index/opensearch/client.py"
            before, after = client.read_text().split('class OpenSearchIndexClient(OpenSearchClient):', 1)
            after = patch_once(after, '        super().__init__(\n',
                '        from onyx.ava_namespace import validate_index_name\n'
                '        index_name = validate_index_name(index_name)\n'
                '        super().__init__(\n')
            client_text = before + 'class OpenSearchIndexClient(OpenSearchClient):' + after
            config.write_text(text)
            client.write_text(client_text)
            shutil.copyfile(ROOT / "native_modules/onyx/ava_namespace.py", tree / "backend/onyx/ava_namespace.py")
            changed = ["backend/onyx/configs/app_configs.py", "backend/onyx/document_index/opensearch/client.py", "backend/onyx/ava_namespace.py"]
            manifest = {"upstream_commit": pinned["commit"], "upstream_archive_sha256": pinned["archive_sha256"],
                "changes": {name: sha(tree / name) for name in changed}, "commercial_files_modified": False,
                "native_login_verified": False, "storage_acl_verified": False, "production_ready": False}
            (tree / "AVA_EXTENSION_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
            return manifest
        except Exception:
            # Only the newly created output is ours; never touch a caller's tree.
            shutil.rmtree(output)
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.archive, args.output), sort_keys=True))
    except (ValueError, OSError, tarfile.TarError):
        raise SystemExit("PINNED_ONYX_EXTENSION_PREPARATION_FAILED")
