"""Build-time only; patch verified free source in a new image, never live files."""
import hashlib
import json
import os
from pathlib import Path
import shutil


def install():
    if os.environ.get("AVA_EXTENSION_BUILD") != "1":
        raise ValueError("IMAGE_BUILD_ONLY")
    root = Path("/app")
    assets = Path("/tmp/ava-extension")
    pinned = json.loads((assets / "upstreams.lock.json").read_text())["onyx"]
    paths = ["onyx/configs/app_configs.py", "onyx/document_index/opensearch/client.py", "onyx/auth/users.py", "onyx/main.py"]
    for name in paths:
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != pinned["files"]["backend/" + name]:
            raise ValueError("INSTALLED_UPSTREAM_SOURCE_MISMATCH")
    config = root / paths[0]
    old = 'DOCUMENT_INDEX_NAME = "danswer_index"'
    text = config.read_text()
    if text.count(old) != 1:
        raise ValueError("UPSTREAM_PATCH_CONTEXT_CHANGED")
    text = text.replace(old, 'from onyx.ava_namespace import document_index_name, bucket_name, validate_runtime_storage\n'
        'validate_runtime_storage()\nDOCUMENT_INDEX_NAME = document_index_name()', 1)
    old = 'S3_FILE_STORE_BUCKET_NAME = (\n    os.environ.get("S3_FILE_STORE_BUCKET_NAME") or "onyx-file-store-bucket"\n)'
    if text.count(old) != 1:
        raise ValueError("UPSTREAM_PATCH_CONTEXT_CHANGED")
    text = text.replace(old, 'S3_FILE_STORE_BUCKET_NAME = bucket_name()', 1)
    client = root / paths[1]
    before, after = client.read_text().split('class OpenSearchIndexClient(OpenSearchClient):', 1)
    if after.count('        super().__init__(\n') != 1:
        raise ValueError("UPSTREAM_PATCH_CONTEXT_CHANGED")
    after = after.replace('        super().__init__(\n', '        from onyx.ava_namespace import validate_index_name\n'
        '        index_name = validate_index_name(index_name)\n        super().__init__(\n', 1)
    # Every precondition is checked before changing either upstream file.
    config.write_text(text)
    client.write_text(before + 'class OpenSearchIndexClient(OpenSearchClient):' + after)
    shutil.copyfile(assets / "ava_namespace.py", root / "onyx/ava_namespace.py")
    modified = [paths[0], paths[1], "onyx/ava_namespace.py"]
    manifest = {"upstream_commit": pinned["commit"], "commercial_files_modified": False,
        "changes": {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in modified},
        "native_login_verified": False, "storage_acl_verified": False, "production_ready": False}
    (root / "AVA_EXTENSION_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    install()
