#!/usr/bin/env python3
"""Build a committed-only four-service bundle. Does not use Docker or SSH."""
import sys
sys.dont_write_bytecode = True
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import urlopen

from common import (ADMIN, BASE, CORE_HASH, DEPENDENCIES, ENGINE, IMAGES, NAMES,
                    blob, canonical, commit, file_sha, git, relative, require,
                    sha, tree, validate_manifest, validate_receipt)


def source_changes(repo, candidate):
    result = {'crm': {}, 'worker': {}, 'engine': {}, 'admin': {}}
    tokens = git(repo, 'diff', '--no-renames', '--name-status', '-z', BASE, candidate).split(b'\0')
    require(tokens[-1] == b'' and len(tokens[:-1]) % 2 == 0, 'SOURCE_DIFF_INVALID')
    selected = {}
    for offset in range(0, len(tokens) - 1, 2):
        status, name = tokens[offset].decode(), tokens[offset + 1].decode()
        relative(name)
        runtime = (name.startswith('src/') and name.endswith('.py') or
                   name.startswith('admin_ui/backend/') and name.endswith('.py') or
                   name.startswith('whatsapp_crm/src/') and name.endswith('.js') or
                   name in ('whatsapp_crm/server.js', 'whatsapp_crm/provisioning-worker.js'))
        if runtime:
            require(status in ('A', 'M'), 'RUNTIME_DELETION_OR_RENAME_REQUIRES_REVIEW')
            selected[name] = status
    # Always include the existing common entrypoints/shared store. Unchanged
    # copies keep exact hashes and make all four role preimages explicit.
    for name in ENGINE | ADMIN | {'whatsapp_crm/src/app.js'}:
        selected.setdefault(name, 'M')
    for name in selected:
        content = blob(repo, candidate, name)
        if name.startswith('src/'):
            result['engine'][name] = (name, content)
            if name == 'src/core/outbound_store.py':
                result['admin']['__shared_runtime__/' + name] = (name, content)
        elif name.startswith('admin_ui/backend/'):
            result['admin'][name.removeprefix('admin_ui/backend/')] = (name, content)
        else:
            target = name.removeprefix('whatsapp_crm/')
            for role in ('crm', 'worker'):
                result[role][target] = (name, content)
    return result


def extract_package(data, integrity, name, version):
    """No npm lifecycle scripts; permit only regular files/directories."""
    expected = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
    require(expected == integrity, 'DEPENDENCY_INTEGRITY_FAILED')
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        entries = archive.getmembers()
        require(len(entries) <= 10000 and sum(x.size for x in entries) <= 30 * 1024 * 1024, 'DEPENDENCY_ARCHIVE_TOO_LARGE')
        for item in entries:
            require(item.name.startswith('package/'), 'DEPENDENCY_ARCHIVE_PATH_INVALID')
            path = item.name.removeprefix('package/').rstrip('/')
            if not path:
                require(item.isdir(), 'DEPENDENCY_ARCHIVE_PATH_INVALID'); continue
            relative(path)
            require(item.isfile() or item.isdir(), 'DEPENDENCY_ARCHIVE_SPECIAL_FILE')
            if item.isfile():
                require(path not in result, 'DEPENDENCY_ARCHIVE_DUPLICATE')
                result[path] = archive.extractfile(item).read()
    package = json.loads(result['package.json'])
    require(package['name'] == name and package['version'] == version and
            not package.get('gypfile'), 'DEPENDENCY_METADATA_MISMATCH')
    return result


def dependencies(repo, candidate, cache):
    lock = json.loads(blob(repo, candidate, 'whatsapp_crm/package-lock.json'))
    require(lock['packages']['node_modules/read-excel-file']['version'] == '9.3.12', 'CATALOG_DEPENDENCY_NOT_PINNED')
    result, receipts = {}, {}
    for name, version in DEPENDENCIES.items():
        item = lock['packages']['node_modules/' + name]
        url = f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz'
        require(item['version'] == version and item['resolved'] == url and item.get('integrity', '').startswith('sha512-'), 'DEPENDENCY_LOCK_CHANGED')
        path = cache / (name + '-' + version + '.tgz')
        if path.exists():
            require(path.is_file() and not path.is_symlink(), 'DEPENDENCY_CACHE_INVALID')
            data = path.read_bytes()
        else:
            with urlopen(url, timeout=30) as response:
                data = response.read(10 * 1024 * 1024 + 1)
            require(len(data) <= 10 * 1024 * 1024, 'DEPENDENCY_DOWNLOAD_TOO_LARGE')
        files = extract_package(data, item['integrity'], name, version)
        if not path.exists():
            path.write_bytes(data)
        for path, content in files.items():
            result['product-dependencies/node_modules/' + name + '/' + path] = content
        receipts[name] = {'version': version, 'integrity': item['integrity'], 'tarballSha256': sha(data), 'fileCount': len(files)}
    return result, receipts


def build(args):
    repo = args.repo.resolve()
    candidate = commit(repo, args.candidate)
    require(commit(repo, BASE) == BASE, 'BASE_CHANGED')
    for name in ('whatsapp_crm/package.json', 'whatsapp_crm/package-lock.json'):
        require(blob(repo, candidate, name) == blob(repo, BASE, name), 'DEPENDENCY_CHANGE_REQUIRES_EXPLICIT_REVIEW')
    git(repo, 'merge-base', '--is-ancestor', BASE, candidate)
    output = args.output.absolute()
    require(not output.exists() and not output.is_symlink(), 'OUTPUT_EXISTS')
    output.parent.mkdir(parents=True, exist_ok=True)
    inventory = json.loads(args.inventory.read_text())
    require(inventory.get('kind') == 'customer-path-inventory' and set(inventory['services']) == set(NAMES), 'INVENTORY_INVALID')
    frontend = tree(args.frontend_dist)
    frontend_receipt = json.loads(args.frontend_receipt.read_text())
    validate_receipt(frontend_receipt, candidate, frontend)
    require(frontend_receipt.get('sourceTree') == git(repo, 'rev-parse', candidate + ':whatsapp_crm/frontend').decode().strip()
            and frontend_receipt.get('lockSha256') == sha(blob(repo, candidate, 'whatsapp_crm/frontend/package-lock.json'))
            and frontend_receipt.get('builderSha256') == sha(blob(repo, candidate, 'scripts/customer-completion-release/build_frontend.py'))
            and frontend_receipt.get('builtFromFreshGitExport') is True, 'FRESH_COMMITTED_FRONTEND_PROVENANCE_REQUIRED')
    overrides = {}
    for item in args.base_file_commit:
        key, origin = item.split('=', 1)
        role, path = key.split(':', 1)
        require(role in NAMES and (role, path) not in overrides, 'BASE_OVERRIDE_INVALID')
        overrides[(role, path)] = commit(repo, origin)
    changes = source_changes(repo, candidate)
    args.dependency_cache.mkdir(parents=True, exist_ok=True)
    dependency_files, dependency_receipt = dependencies(repo, candidate, args.dependency_cache)
    payload = {role: {} for role in NAMES}
    manifest = {'kind': 'customer-completion-20261018', 'schemaVersion': 1, 'baseCommit': BASE,
                'candidateCommit': candidate, 'inventorySha256': file_sha(args.inventory),
                'reviewedCoreSha256': CORE_HASH, 'services': {},
                'frontendReceipt': frontend_receipt, 'dependencies': dependency_receipt,
                'schemaContract': json.loads(blob(repo, candidate, 'scripts/customer-completion-release/schema-contract.json')),
                'tooling': {}}
    used = set()
    for role in NAMES:
        before = inventory['services'][role]
        require(before['image'] == IMAGES[role], 'BASE_IMAGE_CHANGED')
        base_files, origins = {}, {}
        for path, (repo_path, content) in changes[role].items():
            origin = overrides.get((role, path), BASE)
            if (role, path) in overrides:
                used.add((role, path))
            old = blob(repo, origin, repo_path, optional=True)
            expected = sha(old) if old is not None else None
            require(before['hashes'].get(path) == expected, 'PRODUCTION_PREIMAGE_DRIFT:' + role + ':' + path)
            base_files[path], origins[path] = expected, origin
            payload[role][path] = content
        if role in ('crm', 'worker'):
            for path, content in dependency_files.items():
                if path in before['hashes']:
                    require(before['hashes'][path] == sha(content), 'EXISTING_ISOLATED_DEPENDENCY_DRIFT')
                    continue
                payload[role][path], base_files[path] = content, None
        if role == 'crm':
            wav = blob(repo, candidate, 'assets/audio/office-ambience.wav')
            asset = 'assets/audio/office-ambience.wav'
            payload[role][asset], base_files[asset] = wav, before['hashes'].get(asset)
            for path in frontend:
                name = 'frontend/dist/' + path
                payload[role][name] = (args.frontend_dist / path).read_bytes()
                base_files[name] = before['hashes'].get(name)
        files = {path: sha(data) for path, data in payload[role].items()}
        tag = 'ava-customer-completion-' + role + ':' + candidate[:12] + '-' + sha(canonical(files))[:10]
        manifest['services'][role] = {'baseImage': IMAGES[role], 'candidateTag': tag,
            'files': files, 'baseFiles': base_files, 'sourceOrigins': origins,
            'frontendExact': role == 'crm', 'excludedMounts': before['excludedMounts'],
            'baseTreeSha256': sha(canonical(before['hashes']))}
    require(set(overrides) == used, 'UNUSED_BASE_OVERRIDE')
    tooling_paths = git(repo, 'ls-tree', '-r', '--name-only', candidate, 'scripts/customer-completion-release').decode().splitlines()
    require(tooling_paths, 'COMMITTED_RELEASE_TOOLING_REQUIRED')
    temp = Path(tempfile.mkdtemp(prefix='.customer-path-', dir=output.parent))
    try:
        for role, files in payload.items():
            for path, content in files.items():
                target = temp / 'payload' / role / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        for path in tooling_paths:
            if path.endswith(('.py', '.cjs', '.json')):
                data = blob(repo, candidate, path)
                name = path.removeprefix('scripts/customer-completion-release/')
                target = temp / 'tooling' / name
                target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
                manifest['tooling'][name] = sha(data)
        helper_path = 'scripts/neuro-gemini-release/release_operator.py'
        helper = blob(repo, candidate, helper_path)
        require(sha(helper) == CORE_HASH, 'REVIEWED_HELPER_DRIFT')
        helper_target = temp / 'neuro-gemini-release/release_operator.py'
        helper_target.parent.mkdir(); helper_target.write_bytes(helper)
        (temp / 'inventory.json').write_bytes(args.inventory.read_bytes())
        validate_manifest(manifest)
        (temp / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
        os.rename(temp, output)
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    return {'phase': 'bundled', 'candidateCommit': candidate, 'manifestSha256': file_sha(output / 'manifest.json'),
            'files': {role: len(files) for role, files in payload.items()}, 'productionMutation': False}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'inventory', 'frontend-dist', 'frontend-receipt', 'output', 'dependency-cache'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--base-file-commit', action='append', default=[])
    return p


if __name__ == '__main__':
    print(json.dumps(build(parser().parse_args())))
