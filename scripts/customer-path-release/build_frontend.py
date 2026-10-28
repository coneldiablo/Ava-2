#!/usr/bin/env python3
"""Build frontend from one Git commit in a fresh export, with existing dependencies."""
import sys
sys.dont_write_bytecode = True
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

from common import blob, commit, file_sha, git, private_json, relative, require, tree


def build(args):
    repo = args.repo.resolve(); candidate = commit(repo, args.candidate)
    require(not args.output.exists() and not args.output.is_symlink(), 'FRONTEND_OUTPUT_EXISTS')
    require(args.node_modules.is_dir(), 'EXISTING_FRONTEND_DEPENDENCIES_REQUIRED')
    args.output.mkdir(parents=True)
    data = git(repo, 'archive', candidate, 'whatsapp_crm/frontend')
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for item in archive.getmembers():
            relative(item.name.rstrip('/'))
            require(item.isfile() or item.isdir(), 'FRONTEND_SOURCE_SPECIAL_FILE')
            target = args.output / 'source' / item.name
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(archive.extractfile(item).read())
    app = args.output / 'source/whatsapp_crm/frontend'
    require(not (app / 'node_modules').exists(), 'FRONTEND_TRACKED_DEPENDENCIES_FORBIDDEN')
    (app / 'node_modules').symlink_to(args.node_modules.resolve(), target_is_directory=True)
    # Vite build defines are provided by committed sources/configuration only.
    env = {k: v for k, v in os.environ.items() if not k.startswith('VITE_')}
    env['NODE_ENV'] = 'production'
    result = subprocess.run(['npm', 'run', 'build'], cwd=app, env=env, capture_output=True, text=True, timeout=600)
    (args.output / 'build.log').write_text(result.stdout + result.stderr)
    require(result.returncode == 0, 'COMMITTED_FRONTEND_BUILD_FAILED')
    files = tree(app / 'dist')
    receipt = {'sourceCommit': candidate, 'sourceTree': git(repo, 'rev-parse', candidate + ':whatsapp_crm/frontend').decode().strip(),
               'lockSha256': file_sha(app / 'package-lock.json'), 'files': files,
               'builderSha256': file_sha(Path(__file__)), 'builtFromFreshGitExport': True}
    private_json(args.output / 'frontend-receipt.json', receipt)
    return {'phase': 'frontend_built', 'sourceCommit': candidate, 'dist': str(app / 'dist'),
            'receipt': str(args.output / 'frontend-receipt.json'), 'files': len(files), 'productionMutation': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node-modules', type=Path, required=True)
    print(json.dumps(build(parser.parse_args())))
