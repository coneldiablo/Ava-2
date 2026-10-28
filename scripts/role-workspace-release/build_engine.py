#!/usr/bin/env python3
"""Package an optional Python src overlay on the pinned installed engine image."""
import argparse
import json
from pathlib import Path
import re

from shared import BASE, reviewed

b = reviewed('registration_builder')


def build(args):
    for commit in (BASE, args.candidate):
        b.validate_commit(args.repo, commit)
    b.git(args.repo, 'merge-base', '--is-ancestor', BASE, args.candidate)
    b.require(not args.output.exists() and not args.output.is_symlink(), 'OUTPUT_EXISTS')
    inventory = b.read_json(args.inventory)
    b.require(b.IMAGE.fullmatch(inventory.get('image', '')), 'ENGINE_BASE_UNPINNED')
    records = b.git(args.repo, 'diff', '--name-status', '--no-renames', '-z', BASE, args.candidate, '--', 'src').split(b'\0')
    files, bases, origins = {}, {}, {}
    overrides = {}
    for entry in args.base_file_commit:
        path, commit = entry.split('=', 1)
        b.relative(path)
        b.validate_commit(args.repo, commit)
        b.require(path not in overrides, 'ENGINE_DUPLICATE_PROVENANCE')
        overrides[path] = commit
    payload = {}
    for index in range(0, len(records) - 1, 2):
        status, raw = records[index:index + 2]
        path = raw.decode()
        b.relative(path)
        b.require(path.startswith('src/') and path.endswith('.py') and status in (b'A', b'M'), 'ENGINE_RUNTIME_CHANGE_UNSUPPORTED')
        origin = overrides.get(path, BASE)
        old = b.blob(args.repo, origin, path, optional=path not in overrides)
        expected = None if old is None else b.sha(old)
        b.require(inventory['sourceHashes'].get(path) == expected, 'ENGINE_SOURCE_DRIFT:' + path)
        content = b.blob(args.repo, args.candidate, path)
        payload[path] = content
        files[path], bases[path], origins[path] = b.sha(content), expected, origin
    b.require(files and set(overrides) <= set(files), 'ENGINE_EMPTY_OR_UNSELECTED_PROVENANCE')
    args.output.mkdir(mode=0o700, parents=True)
    for path, content in payload.items():
        target = args.output / 'payload' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    manifest = {'releaseKind': 'role-workspace-engine', 'baseCommit': BASE, 'candidateCommit': args.candidate,
                'baseImage': inventory['image'], 'baseFiles': bases, 'baseFileCommits': origins, 'files': files}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    return {'candidateCommit': args.candidate, 'manifestSha256': b.sha((args.output / 'manifest.json').read_bytes()),
            'sourceFiles': len(files), 'productionMutation': False}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'inventory', 'output'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--base-file-commit', action='append', default=[])
    print(json.dumps(build(p.parse_args())))
