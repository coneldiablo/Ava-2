#!/usr/bin/env python3
"""Local real-FS repair regressions. Docker/admission and root ownership are fixtures.
No SSH, production access, model calls or application startup.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import types


def main():
    helper = Path(__file__).with_name('customer-completion-knowledge-repair.py')
    spec = importlib.util.spec_from_file_location('repair', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    definitions = module.REMOTE.rsplit('run();print', 1)[0]
    cases = ['success_publish', 'verify_failure_restores_absence',
             'concurrent_replacement_preserved', 'preexisting_target_preserved',
             'changed_admission_refused', 'same_bytes_replacement_during_rollback_capture']
    results = []
    for case in cases:
        base = tempfile.mkdtemp(prefix='ava-repair-local-test-')
        root = base + '/config'
        os.mkdir(root, 0o750)
        ns = {'MODE': 'apply'}
        exec(definitions, ns)
        state, candidate, fence = base + '/state', {'fixture': 'owned-config'}, {'fixture': 'admission'}
        ns.update(EXPECTED_HOST_DIR=root, STATE_ROOT=state, EXPECTED_FENCE=ns['digest'](fence))
        report = ns['report']
        report['expectedAdmissionFenceMatches'] = case != 'changed_admission_refused'
        if case == 'preexisting_target_preserved':
            Path(root + '/1.json').write_text('existing')

        def prepare():
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            metadata, manifest = os.fstat(fd), ns['directory_manifest'](fd)
            report.update(expectedManifestMatches=not bool(manifest),
                          targetPresent=os.path.exists(root + '/1.json'),
                          currentAdmissionFenceSha256=ns['digest'](fence))
            return {}, candidate, fd, metadata, manifest, '1.json', {'defaultPresent': False}

        def verify(candidate, fd, target):
            assert Path(root + '/' + target).read_bytes() == ns['canonical'](candidate)
            assert os.stat(root + '/' + target).st_mode & 0o777 == 0o440
            if case in ['verify_failure_restores_absence', 'same_bytes_replacement_during_rollback_capture']:
                raise ns['Refused']('TEST_VERIFY_FAILED')
            if case == 'concurrent_replacement_preserved':
                Path(root + '/replacement').write_text('concurrent')
                os.replace(root + '/replacement', root + '/' + target)
                raise ns['Refused']('TEST_VERIFY_FAILED')

        ns.update(prepare=prepare, docker_json=lambda *a, **k: {'fence': fence}, verify_existing=verify)
        proxy = types.SimpleNamespace(**{key: getattr(os, key) for key in dir(os)})
        proxy.fchown = lambda *a: None  # Ownership only; all namespace/inode operations are real.
        original_lstat, original_rename = os.lstat, os.rename

        def lstat(path, *args, **kwargs):
            metadata = original_lstat(path, *args, **kwargs)
            return types.SimpleNamespace(st_mode=metadata.st_mode, st_uid=0) if path == state else metadata

        race = {}

        def rename(src, dst, *args, **kwargs):
            if case == 'same_bytes_replacement_during_rollback_capture' and src == '1.json' and dst == 'config':
                # Interleave a second coordinator inside rollback, immediately
                # before its atomic capture. Bytes match; inode ownership does not.
                race['originalInode'] = os.stat(root + '/1.json').st_ino
                Path(root + '/replacement').write_bytes(ns['canonical'](candidate))
                race['replacementInode'] = os.stat(root + '/replacement').st_ino
                assert race['replacementInode'] != race['originalInode']
                os.replace(root + '/replacement', root + '/1.json')
            return original_rename(src, dst, *args, **kwargs)

        proxy.lstat, proxy.rename = lstat, rename
        ns['os'] = proxy
        try:
            ns['run']()
            present = os.path.exists(root + '/1.json')
            if case == 'success_publish':
                assert report['pass'] and present and report['configWrites'] == 1
            elif case == 'verify_failure_restores_absence':
                assert not report['pass'] and not present and report['originalAbsenceRestored']
                assert not report.get('quarantineRetained')
            elif case == 'concurrent_replacement_preserved':
                assert not report['pass'] and Path(root + '/1.json').read_text() == 'concurrent'
                assert report['rootReconciliationRequired'] and report['foreignTargetRestored'] and report['quarantineRetained']
            elif case == 'preexisting_target_preserved':
                assert not report['pass'] and Path(root + '/1.json').read_text() == 'existing' and report['configWrites'] == 0
            elif case == 'changed_admission_refused':
                assert not report['pass'] and not present and report['configWrites'] == 0
                assert report['errorCode'] == 'ADMISSION_FENCE_CHANGED'
            else:
                assert not report['pass'] and report['rootReconciliationRequired']
                assert report['foreignTargetRestored'] and report['quarantineRetained']
                assert os.stat(root + '/1.json').st_ino == race['replacementInode']
                assert os.stat(root + '/' + report['quarantineRetained'] + '/config').st_ino == race['replacementInode']
                assert Path(root + '/1.json').read_bytes() == ns['canonical'](candidate)
            results.append({'case': case, 'status': 'PASS', **({'differentInodeSameBytesPreserved': True,
                            'foreignCopyRetainedInQuarantine': True} if race else {})})
        finally:
            shutil.rmtree(base)
    print(json.dumps({'level': 'local_real_filesystem_with_root_ownership_and_docker_admission_fixtures',
                      'rootOwnershipOperationsSimulated': True, 'serverApplyExecuted': False,
                      'passed': len(results), 'results': results}, indent=2))


if __name__ == '__main__':
    main()
