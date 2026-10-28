#!/usr/bin/env python3
"""Inventory the baked Onyx Hugging Face cache from inside its model image."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


SOURCE_COMMIT = "a1b9e02eb65cc114c65381cbef5e555e1753ed0a"
CACHE_ROOT = Path("/app/.cache/temp_huggingface/hub")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
MODEL = re.compile(r"models--[A-Za-z0-9_.-]+--[A-Za-z0-9_.-]+\Z")
BLOB = re.compile(r"[0-9a-f]+\Z")
REVISION = re.compile(r"[0-9a-f]{40}\Z")
SAFE_PART = re.compile(r"[A-Za-z0-9_.-]+\Z")
CACHE_TAG_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55"


class InspectionError(RuntimeError):
    pass


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _valid_directory(relative: Path) -> bool:
    parts = relative.parts
    if len(parts) == 1:
        return bool(MODEL.fullmatch(parts[0]))
    if len(parts) < 2 or not MODEL.fullmatch(parts[0]) or parts[1] not in {"blobs", "refs", "snapshots"}:
        return False
    if parts[1] == "blobs":
        return len(parts) == 2
    if parts[1] == "snapshots":
        return len(parts) >= 2 and (len(parts) == 2 or REVISION.fullmatch(parts[2]) is not None) and all(SAFE_PART.fullmatch(part) for part in parts[3:])
    return all(SAFE_PART.fullmatch(part) for part in parts[2:])


def _valid_file(relative: Path) -> bool:
    parts = relative.parts
    if len(parts) < 3 or not MODEL.fullmatch(parts[0]):
        return False
    if parts[1] == "blobs":
        return len(parts) == 3 and BLOB.fullmatch(parts[2]) is not None
    if parts[1] == "refs":
        return all(SAFE_PART.fullmatch(part) for part in parts[2:])
    return (parts[1] == "snapshots" and len(parts) >= 4
            and REVISION.fullmatch(parts[2]) is not None
            and all(SAFE_PART.fullmatch(part) for part in parts[3:]))


def _metadata_directory(relative: Path) -> bool:
    parts = relative.parts
    if parts == (".locks",):
        return True
    if len(parts) == 2 and parts[0] == ".locks":
        return MODEL.fullmatch(parts[1]) is not None
    if len(parts) >= 2 and MODEL.fullmatch(parts[0]) and parts[1] == ".no_exist":
        return (len(parts) == 2
                or (REVISION.fullmatch(parts[2]) is not None
                    and all(SAFE_PART.fullmatch(part) for part in parts[3:])))
    return False


def _metadata_file(relative: Path) -> bool:
    parts = relative.parts
    if (len(parts) == 3 and parts[0] == ".locks" and MODEL.fullmatch(parts[1])
            and re.fullmatch(r"[0-9a-f]+\.lock", parts[2])):
        return True
    return (len(parts) >= 4 and MODEL.fullmatch(parts[0]) and parts[1] == ".no_exist"
            and REVISION.fullmatch(parts[2]) is not None
            and all(SAFE_PART.fullmatch(part) for part in parts[3:]))


def _validate_cache_tag(path: Path, info: os.stat_result) -> None:
    if not stat.S_ISREG(info.st_mode) or not len(CACHE_TAG_SIGNATURE) + 1 <= info.st_size <= 4096:
        raise InspectionError("MODEL_CACHE_TAG_INVALID")
    try:
        content = path.read_bytes().decode("ascii")
    except (OSError, UnicodeError) as exc:
        raise InspectionError("MODEL_CACHE_TAG_INVALID") from exc
    lines = content.splitlines()
    if (not lines or lines[0] != CACHE_TAG_SIGNATURE
            or any(not line.startswith("#") or any(character not in "\t" and not " " <= character <= "~" for character in line)
                   for line in lines[1:])):
        raise InspectionError("MODEL_CACHE_TAG_INVALID")


def inspect_cache(root: Path, image_digest: str) -> dict:
    if not DIGEST.fullmatch(image_digest):
        raise InspectionError("MODEL_IMAGE_DIGEST_INVALID")
    try:
        root_info = root.lstat()
        resolved_root = root.resolve(strict=True)
    except OSError as exc:
        raise InspectionError("MODEL_CACHE_INVALID") from exc
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise InspectionError("MODEL_CACHE_INVALID")

    files: list[dict] = []
    inode_hashes: dict[tuple[int, int], tuple[str, int]] = {}
    model_kinds: dict[str, set[str]] = {}
    models_seen: set[str] = set()
    refs: list[tuple[str, Path]] = []
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as exc:
            raise InspectionError("MODEL_CACHE_INVALID") from exc
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(root)
            try:
                info = path.lstat()
            except OSError as exc:
                raise InspectionError("MODEL_CACHE_INVALID") from exc
            if stat.S_ISDIR(info.st_mode):
                if _metadata_directory(relative):
                    stack.append(path)
                    continue
                if not _valid_directory(relative):
                    raise InspectionError("MODEL_CACHE_PATH_INVALID")
                if len(relative.parts) == 1:
                    models_seen.add(relative.parts[0])
                stack.append(path)
                continue
            if relative.parts == ("CACHEDIR.TAG",):
                _validate_cache_tag(path, info)
                continue
            if _metadata_file(relative):
                if not stat.S_ISREG(info.st_mode) or info.st_size != 0:
                    raise InspectionError("MODEL_CACHE_METADATA_INVALID")
                continue
            if not _valid_file(relative):
                raise InspectionError("MODEL_CACHE_PATH_INVALID")
            parts = relative.parts
            model_kinds.setdefault(parts[0], set()).add(parts[1])
            resolved = path
            if stat.S_ISLNK(info.st_mode):
                if parts[1] != "snapshots":
                    raise InspectionError("MODEL_CACHE_SYMLINK_INVALID")
                try:
                    resolved = path.resolve(strict=True)
                    target_info = resolved.stat()
                except OSError as exc:
                    raise InspectionError("MODEL_CACHE_SYMLINK_INVALID") from exc
                blob_root = (root / parts[0] / "blobs").resolve(strict=True)
                if not _inside(resolved, blob_root) or not stat.S_ISREG(target_info.st_mode):
                    raise InspectionError("MODEL_CACHE_SYMLINK_INVALID")
                info = target_info
            elif not stat.S_ISREG(info.st_mode):
                raise InspectionError("MODEL_CACHE_PATH_INVALID")
            if info.st_size < 1:
                raise InspectionError("MODEL_CACHE_FILE_EMPTY")
            inode = (info.st_dev, info.st_ino)
            if inode not in inode_hashes:
                inode_hashes[inode] = (_hash_file(resolved), info.st_size)
            digest, size = inode_hashes[inode]
            files.append({"path": relative.as_posix(), "sha256": digest, "size": size})
            if parts[1] == "refs":
                refs.append((parts[0], resolved))

    if (not files or not models_seen or set(model_kinds) != models_seen
            or any(kinds != {"blobs", "refs", "snapshots"} for kinds in model_kinds.values())):
        raise InspectionError("MODEL_CACHE_PATH_SET_INCOMPLETE")
    for model, reference in refs:
        try:
            revision = reference.read_text(encoding="ascii").strip()
        except (OSError, UnicodeError) as exc:
            raise InspectionError("MODEL_CACHE_REFERENCE_INVALID") from exc
        if not REVISION.fullmatch(revision) or not (root / model / "snapshots" / revision).is_dir():
            raise InspectionError("MODEL_CACHE_REFERENCE_INVALID")
    return {
        "schemaVersion": 1,
        "sourceCommit": SOURCE_COMMIT,
        "modelImageDigest": image_digest,
        "cacheRoot": str(CACHE_ROOT),
        "files": sorted(files, key=lambda item: item["path"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-digest", required=True)
    args = parser.parse_args()
    manifest = inspect_cache(CACHE_ROOT, args.image_digest)
    sys.stdout.write(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


def entrypoint() -> int:
    try:
        return main()
    except InspectionError as exc:
        raise SystemExit(str(exc))
    except (OSError, ValueError):
        raise SystemExit("MODEL_CACHE_INSPECTION_IO_FAILED")


if __name__ == "__main__":
    raise SystemExit(entrypoint())
