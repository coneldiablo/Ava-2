#!/usr/bin/env python3
"""Archive source contexts with explicit non-secret code permissions.

Directory entries are mandatory: a private host umask must not turn container
module directories into root-only paths after extraction and COPY.
"""
import argparse
import os
from pathlib import Path
import tarfile


def pack(root, target):
    if target.exists() or target.is_symlink():
        raise RuntimeError("ARCHIVE_EXISTS")
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise RuntimeError("ARCHIVE_EXISTS") from None
    with os.fdopen(descriptor, "wb") as stream, tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path in sorted(root.rglob("*")):
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise RuntimeError("UNSUPPORTED_ARCHIVE_ENTRY")
            relative = str(path.relative_to(root))
            if path.name.endswith(".env") or "private" in path.name:
                raise RuntimeError("PRIVATE_FILE_IN_BUILD_CONTEXT")
            info = archive.gettarinfo(str(path), relative)
            info.mode = 0o755 if path.is_dir() else 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            # Express uses size+mtime for the SPA's weak ETag. A fixed zero
            # timestamp would make equal-length index files from different
            # releases share validators and leave a browser on the old bundle.
            info.mtime = path.stat().st_mtime if path.is_file() else 0
            if path.is_file():
                with path.open("rb") as stream:
                    archive.addfile(info, stream)
            else:
                archive.addfile(info)


def unpack(source, target):
    if target.exists() or target.is_symlink():
        raise RuntimeError("EXTRACTION_TARGET_EXISTS")
    with tarfile.open(source) as archive:
        for info in archive.getmembers():
            parts = Path(info.name).parts
            if info.name.startswith("/") or ".." in parts or "\\" in info.name or not (info.isfile() or info.isdir()):
                raise RuntimeError("UNSUPPORTED_ARCHIVE_ENTRY")
            if info.size > 20_000_000:
                raise RuntimeError("ARCHIVE_ENTRY_TOO_LARGE")
        if sum(info.size for info in archive.getmembers()) > 100_000_000:
            raise RuntimeError("ARCHIVE_TOO_LARGE")
        target.mkdir(mode=0o755)
        archive.extractall(target, filter="data")
    # Python's data filter deliberately ignores directory mode metadata.
    # Apply code-only modes explicitly after safe extraction, irrespective of
    # the operator's private umask. No credential files belong in this context.
    target.chmod(0o755)
    for path in target.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--extract", action="store_true")
    args = parser.parse_args()
    (unpack if args.extract else pack)(args.root, args.target)
