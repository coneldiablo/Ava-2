#!/usr/bin/env python3
"""Package committed CRM/worker deltas and exact built frontend, without Docker/SSH."""
import argparse
import json
from pathlib import Path
import shutil
import tempfile
import os

from shared import BASE, COLUMN_MIGRATIONS, PRIVATE_RUNTIME, environment, modules, reviewed, schema, trigger_replacements

b = reviewed('registration_builder')
original_is_runtime = b.is_runtime
# Registration also packages explicit contract tests. Role release packages
# runtime only, plus this single reviewed legacy Instagram entrypoint.
b.is_runtime = lambda path: path == PRIVATE_RUNTIME or (
    original_is_runtime(path) and not path.startswith('tests/') and path != 'test-helper.js')


def file_commit_overrides(repo, entries, selected):
    private, regular = [], []
    for entry in entries:
        b.require(isinstance(entry, str) and entry.count('=') == 1, 'INVALID_BASE_FILE_COMMIT')
        (private if entry.split('=', 1)[0] == PRIVATE_RUNTIME else regular).append(entry)
    result = b.file_commit_overrides(repo, regular, selected)
    for entry in private:
        path, commit = entry.split('=', 1)
        b.require(path in selected, 'BASE_FILE_COMMIT_NOT_OVERLAID')
        b.require(path not in result, 'DUPLICATE_BASE_FILE_COMMIT')
        b.validate_commit(repo, commit)
        b.blob(repo, commit, 'whatsapp_crm/' + path)
        result[path] = commit
    return result


def build(args):
    repo, output = args.repo.resolve(), args.output.absolute()
    for commit in (args.base, args.candidate):
        b.validate_commit(repo, commit)
    b.require(args.base == BASE, 'RELEASE_BASE_MISMATCH')
    b.git(repo, 'merge-base', '--is-ancestor', args.base, args.candidate)
    b.require(not output.exists() and not output.is_symlink(), 'OUTPUT_EXISTS')
    inventory = b.read_json(args.inventory)
    changes = b.runtime_changes(repo, args.base, args.candidate, True)
    frontend_receipt = b.read_json(args.frontend_receipt)
    b.require(frontend_receipt.get('sourceCommit') == args.candidate, 'FRONTEND_COMMIT_MISMATCH')
    frontend = b.frontend_artifact(args.frontend_dist, b.hash_map(frontend_receipt['files']))
    env = environment(b.read_json(args.environment_json) if args.environment_json else {})
    migration, migration_bytes = b.runner(repo, args.candidate, args.migration_runner, 'migrations.cjs')
    contract, contract_bytes = b.runner(repo, args.candidate, args.contract_runner, 'contract.cjs')
    manifest = {'schemaVersion': 2, 'releaseKind': 'role-workspace', 'baseCommit': args.base,
        'candidateCommit': args.candidate, 'publicBaseUrl': 'https://wh.meludtech.tech',
        'publicRoutes': ['/', '/today', '/clients', '/team', '/login', '/register', '/forgot-password'],
        'migrationRunner': migration, 'contractRunner': contract,
        'allowedNewSchema': schema(b.read_json(args.schema_json)),
        'allowedColumnMigrations': COLUMN_MIGRATIONS,
        'allowedTriggerReplacements': trigger_replacements(b.read_json(args.trigger_replacements_json) if getattr(args, 'trigger_replacements_json', None) else []),
        'schemaModules': modules(args.schema_module), 'contractSupportFiles': [],
        'frontendExact': True, 'services': {}}
    payload = {}
    for service, short in (('whatsapp_crm', 'crm'), ('provisioning_worker', 'worker')):
        before = inventory[service]
        b.require(b.IMAGE.fullmatch(before['image']), 'BASE_IMAGE_UNPINNED')
        overrides = file_commit_overrides(repo, getattr(args, short + '_base_file_commit'), changes)
        files, bases, origins = {}, {}, {}
        payload[service] = {}
        for path in changes:
            origin = overrides.get(path, args.base)
            old = b.blob(repo, origin, 'whatsapp_crm/' + path, optional=True)
            expected = None if old is None else b.sha(old)
            b.require(before['sourceHashes'].get(path) == expected, 'PRODUCTION_SOURCE_DRIFT:' + service + ':' + path)
            content = b.blob(repo, args.candidate, 'whatsapp_crm/' + path)
            payload[service][path] = content
            files[path], bases[path], origins[path] = b.sha(content), expected, origin
        if service == 'whatsapp_crm':
            base_frontend = b.hash_map(before['frontendFiles'])
            manifest['frontendBaseFiles'] = base_frontend
            for path, content in frontend.items():
                name = 'frontend/dist/' + path
                payload[service][name] = content
                files[name], bases[name] = b.sha(content), base_frontend.get(path)
        manifest['services'][service] = {'baseCommit': args.base, 'baseImageId': before['image'],
            'candidateTag': 'ava-registration-' + short + ':' + args.candidate[:12] + '-role-' + b.sha(b.canonical(files))[:10],
            'files': files, 'baseFiles': bases, 'baseFileCommits': origins,
            'absentContractSupportFiles': [], 'environment': env[service]}
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix='.ava-role-bundle-', dir=output.parent))
    try:
        for service, files in payload.items():
            for path, content in files.items():
                target = temp / 'payload' / service / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        (temp / 'migrations.cjs').write_bytes(migration_bytes)
        (temp / 'contract.cjs').write_bytes(contract_bytes)
        data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
        (temp / 'manifest.json').write_bytes(data)
        os.rename(temp, output)
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    return {'candidateCommit': args.candidate, 'manifestSha256': b.sha(data),
            'sourceFiles': len(changes), 'frontendFiles': len(frontend), 'productionMutation': False}


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'inventory', 'frontend-dist', 'frontend-receipt', 'schema-json', 'output'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--base', default=BASE)
    p.add_argument('--candidate', required=True)
    p.add_argument('--environment-json', type=Path)
    p.add_argument('--trigger-replacements-json', type=Path)
    p.add_argument('--migration-runner', default='scripts/role-workspace-release/migrations.cjs')
    p.add_argument('--contract-runner', default='scripts/role-workspace-release/contract.cjs')
    p.add_argument('--schema-module', action='append', required=True)
    for service in ('crm', 'worker'):
        p.add_argument('--' + service + '-base-file-commit', action='append', default=[])
    return p


if __name__ == '__main__':
    print(json.dumps(build(parser().parse_args())))
