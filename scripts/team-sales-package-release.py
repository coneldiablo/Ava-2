"""Build an explicit overlay on each captured production image, preserving drift."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tarfile

BASE = 'e0b6482788373c3895c88b608961fb6ed43ac31f'
ROOT = pathlib.Path(__file__).resolve().parents[1]
STATE = pathlib.Path('/tmp/ava-team-sales-20261002')

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).splitlines()

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def hashes(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*')) if p.is_file()}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    out = STATE / 'payload'
    if out.exists(): shutil.rmtree(out)
    out.mkdir(mode=0o700)
    paths = set(git('diff', '--name-only', '--diff-filter=ACMRT', BASE, '--', 'whatsapp_crm/src'))
    paths.update(git('ls-files', '--others', '--exclude-standard', '--', 'whatsapp_crm/src'))
    assert not git('diff', '--name-only', '--diff-filter=D', BASE, '--', 'whatsapp_crm/src'), 'SOURCE_DELETION_REQUIRES_EXPLICIT_OVERLAY'
    changes = {str(pathlib.PurePosixPath(p).relative_to('whatsapp_crm/src')): ROOT / p for p in sorted(paths)}
    assert changes and not any(pathlib.PurePosixPath(p).name.startswith('._') for p in changes)
    runtime = {}
    baseline = {}
    for key in ('crm', 'worker'):
        baseline[key] = json.loads((STATE / f'baseline-{key}-hashes.json').read_text())
        runtime[key] = dict(baseline[key])
        src = out / f'{key}-src'
        for rel, source in changes.items():
            target = src / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            runtime[key][rel] = digest(source)
    rollback_runtime = {}
    for key in ('crm', 'worker'):
        shutil.copytree(out / f'{key}-src', out / f'{key}-rollback-src')
        for rel, source in [('app.js', ROOT / 'scripts/team-sales-emergency-app.js'),
                            ('services/identity/team-emergency-guard.js', ROOT / 'scripts/team-sales-emergency-guard.js')]:
            target = out / f'{key}-rollback-src' / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        rollback_runtime[key] = dict(runtime[key])
        rollback_runtime[key].update(hashes(out / f'{key}-rollback-src'))
    entrypoints = json.loads((STATE / 'baseline-entry-hashes.json').read_text())
    assert set(entrypoints['crm']) == {'server.js'} and set(entrypoints['worker']) == {'provisioning-worker.js'}, 'CAPTURE_ACTUAL_ENTRYPOINTS_REQUIRED'
    entry = ROOT / 'whatsapp_crm/provisioning-worker.js'
    entrypoints['worker']['provisioning-worker.js'] = digest(entry)
    shutil.copyfile(entry, out / 'provisioning-worker.js')
    dist = ROOT / 'whatsapp_crm/frontend/dist'
    assert (dist / 'index.html').is_file(), 'FRONTEND_BUILD_REQUIRED'
    shutil.copytree(dist, out / 'frontend-dist', ignore=shutil.ignore_patterns('._*', '.DS_Store'))
    for key in ('crm', 'worker'):
        base = f'ava-client-{key}:b8fea8e'
        body = f'FROM {base}\nCOPY {key}-src/ /app/src/\nCOPY provisioning-worker.js /app/provisioning-worker.js\n'
        for rollback in (False, True):
            content = body.replace(f'{key}-src/', f'{key}-rollback-src/') if rollback else body
            if key == 'crm' and not rollback:
                content += 'RUN rm -rf /app/frontend/dist\nCOPY frontend-dist/ /app/frontend/dist/\n'
            (out / f'Dockerfile.{key}{".rollback" if rollback else ""}').write_text(content)
    # Synthetic fixtures/tests travel separately from production source overlays.
    shutil.copytree(ROOT / 'whatsapp_crm/tests', out / 'tests', ignore=shutil.ignore_patterns('._*', '.DS_Store'))
    native_paths = set(git('diff', '--name-only', '--diff-filter=ACMRT', BASE, '--', 'native_modules'))
    native_paths.update(git('ls-files', '--others', '--exclude-standard', '--', 'native_modules'))
    for rel in sorted(native_paths):
        if not (ROOT / rel).is_file() or pathlib.PurePosixPath(rel).name.startswith('._'): continue
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, target)
    for source in (ROOT / 'scripts').glob('team-sales-*'):

        if source.is_file(): shutil.copyfile(source, out / source.name)
    template = {'commit': args.commit, 'baseCommit': BASE, 'images': {
        key: f'ava-team-{key}:{args.commit[:12]}' for key in ('crm', 'worker')},
        'rollbackImages': {key: f'ava-team-{key}-compatible:{args.commit[:12]}' for key in ('crm', 'worker')},
        'runtimeSha256': runtime, 'rollbackRuntimeSha256': rollback_runtime,
        'criticalSourceFiles': {key: sorted(rel for rel in runtime[key] if rel != 'app.js') for key in ('crm', 'worker')},
        'emergencyRollbackSha256': {'app.js': digest(ROOT / 'scripts/team-sales-emergency-app.js'),
            'services/identity/team-emergency-guard.js': digest(ROOT / 'scripts/team-sales-emergency-guard.js')},
        'crmBaselineSha256': baseline['crm'], 'workerBaselineSha256': baseline['worker'],
        'frontendSha256': hashes(out / 'frontend-dist'),
        'rollbackFrontendSha256': json.loads((STATE / 'baseline-frontend-hashes.json').read_text()),
        'entrypointSha256': entrypoints,
        'filesSha256': hashes(out), 'sourceOverlayPaths': sorted(changes),
        'backupMaxAgeSeconds': 7200}
    (STATE / 'manifest.template.json').write_text(json.dumps(template, indent=2))
    with tarfile.open(STATE / 'payload.tgz', 'w:gz') as tar:
        for path in sorted(out.rglob('*')):
            if path.is_file(): tar.add(path, arcname=str(path.relative_to(out)), recursive=False)
    print(json.dumps({'overlayFiles': len(changes), 'frontendFiles': len(template['frontendSha256']), 'archiveSha256': digest(STATE / 'payload.tgz')}))

if __name__ == '__main__': main()
