#!/usr/bin/env python3
"""Offline next-release bundle assembly against the reviewed live hash snapshot."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import types

BASE = '9827e7ca5aeaf4a7a824d10bed7102e8c26a7697'
IMAGES = {'whatsapp_crm': 'sha256:f88ecd574dad424c3cc34afc0c268c6b5a4f38ca321ba20776d9609e19b352e4',
          'provisioning_worker': 'sha256:d647fcc605e861417c1bce68a70306fa3b44bbd83593e484d65ae7be8e894d6f'}
CONTRACTS = ['test-helper', 'self-registration.test', 'keycloak-recovery.test', 'identity-protocol.test',
    'owner-invitations.test', 'team-identity-v2.test', 'identity-only-worker.test',
    'registration-revocation-barrier.test', 'worker-startup-safety.test', 'onboarding-state.test',
    'team-enrollment-proof.test', 'staff-native-enrollment-http.test', 'team-email-reconciliation.test',
    'team-invitation-delivery.test', 'team-enrollment-lease-recovery.test', 'team-invitation-session.test',
    'invitation-errors.test', 'assistant-draft.test', 'assistant-public-pages.test',
    'assistant-ai-options.test', 'assistant-draft-access.test', 'hotel-profile.test']
RUNTIME = ['scripts/team-enrollment-lease-recovery.js', 'scripts/team-email-reconciliation.js',
    'src/services/ai.service.js', 'src/services/ai-request.service.js',
    'src/services/assistant-public-pages.service.js', 'src/services/voice-provider.service.js',
    'src/services/pms/pms-utils.js', 'src/services/provisioning/business-provisioning-store.service.js']


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['audit', 'build'])
    parser.add_argument('--repo', type=pathlib.Path, required=True)
    parser.add_argument('--candidate-commit', required=True)
    parser.add_argument('--frontend-dist', type=pathlib.Path)
    parser.add_argument('--frontend-sha256', type=pathlib.Path)
    parser.add_argument('--schema-json', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    parser.add_argument('--staff-enabled', choices=['true', 'false'], default='false')
    parser.add_argument('--contract-support-file', action='append', default=[])
    args = parser.parse_args()
    repo = args.repo.resolve()
    docs = pathlib.Path(__file__).resolve().parents[2] / 'docs/ava-team-onboarding-release'
    spec = importlib.util.spec_from_file_location('ava_bundle', pathlib.Path(__file__).resolve().parents[1] / 'ava-registration-release/build_bundle.py')
    builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
    builder.validate_commit(repo, BASE)
    builder.validate_commit(repo, args.candidate_commit)
    baseline = json.loads((docs / 'live-runtime-base.sha256.json').read_text())
    operator_paths = json.loads((docs / 'live-operator-paths.sha256.json').read_text())
    for service in IMAGES:
        builder.require(not set(operator_paths[service]) & set(baseline[service]), 'DUPLICATE_BASELINE_PATH')
        baseline[service].update(operator_paths[service])
    reviewed = json.loads((docs / 'reviewed-provenance.json').read_text())
    contracts = sorted(set(['tests/'+name+'.js' for name in CONTRACTS] + args.contract_support_file))
    exceptions = {s: [] for s in IMAGES}
    absent = {s: [] for s in IMAGES}
    selected = sorted(set(builder.runtime_changes(repo, BASE, args.candidate_commit, True) + RUNTIME + contracts))
    for service in IMAGES:
        for name in selected:
            # Also assert every explicitly selected candidate blob exists.
            builder.blob(repo, args.candidate_commit, 'whatsapp_crm/'+name)
            source = builder.blob(repo, BASE, 'whatsapp_crm/'+name, optional=True)
            expected = hashlib.sha256(source).hexdigest() if source is not None else None
            actual = baseline[service].get(name)
            if actual == expected:
                continue
            if actual is None and name in contracts:
                absent[service].append(name)
                continue
            evidence = reviewed.get(name, {}).get(service, {})
            commit = evidence.get('matchingGitCommit')
            builder.require(commit and actual == evidence.get('liveSha256'), 'UNREVIEWED_LIVE_SOURCE_DRIFT')
            blob = builder.blob(repo, commit, 'whatsapp_crm/'+name)
            builder.require(hashlib.sha256(blob).hexdigest() == actual, 'PROVENANCE_GIT_MISMATCH')
            exceptions[service].append(name+'='+commit)
    receipt = {'baseCommit': BASE, 'candidateCommit': args.candidate_commit, 'baseImages': IMAGES,
        'runtimeSelectedCount': len(selected), 'contractSupportFiles': contracts,
        'reviewedBaseFileCommits': exceptions, 'absentContractSupportFiles': absent,
        'staffEnabled': args.staff_enabled, 'productionMutation': False}
    if args.action == 'audit':
        print(json.dumps(receipt, indent=2, sort_keys=True)); return 0
    builder.require(all((args.frontend_dist, args.frontend_sha256, args.schema_json, args.output)), 'FINAL_FRONTEND_SCHEMA_OUTPUT_REQUIRED')
    output = args.output.absolute()
    builder.require(not output.exists(), 'OUTPUT_ALREADY_EXISTS')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.ava-team-bundle-', dir=output.parent) as temporary:
        temporary = pathlib.Path(temporary)
        environment = {'whatsapp_crm': {'AVA_TEAM_NEW_ACCOUNT_ENABLED': args.staff_enabled},
            'provisioning_worker': {'AVA_TEAM_NEW_ACCOUNT_ENABLED': args.staff_enabled,
                                   'AVA_PASSWORD_RECOVERY_NO_REDIRECT': 'true'}}
        envfile = temporary/'environment.json'; envfile.write_text(json.dumps(environment))
        bundle_args = types.SimpleNamespace(repo=str(repo), base_commit=BASE, worker_base_commit=BASE,
            candidate_commit=args.candidate_commit, crm_image=IMAGES['whatsapp_crm'], worker_image=IMAGES['provisioning_worker'],
            migration_runner='scripts/ava-registration-release/migrations.cjs',
            contract_runner='scripts/ava-registration-release/contract.cjs',
            schema_json=str(args.schema_json.resolve()), environment_json=str(envfile),
            frontend_dist=str(args.frontend_dist.resolve()), frontend_sha256=str(args.frontend_sha256.resolve()),
            frontend_base_sha256=str(docs/'live-frontend-base.sha256.json'),
            contract_support_file=contracts, runtime_support_file=RUNTIME,
            crm_base_file_commit=exceptions['whatsapp_crm'], worker_base_file_commit=exceptions['provisioning_worker'],
            crm_absent_contract_support_file=absent['whatsapp_crm'], worker_absent_contract_support_file=absent['provisioning_worker'],
            output=str(temporary/'bundle'))
        built = builder.build(bundle_args)
        manifest = json.loads((temporary/'bundle/manifest.json').read_text())
        frontend_base = json.loads((docs/'live-frontend-base.sha256.json').read_text())
        for service, contract in manifest['services'].items():
            for name, expected in contract['baseFiles'].items():
                actual = frontend_base.get(name.removeprefix('frontend/dist/')) if name.startswith('frontend/dist/') else baseline[service].get(name)
                builder.require(actual == expected, 'GENERATED_BASE_FENCE_MISMATCH')
        os.rename(temporary/'bundle', output)
        receipt.update(built)
    print(json.dumps(receipt, indent=2, sort_keys=True)); return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        code = str(error)
        if not code or not all(c.isupper() or c.isdigit() or c == '_' for c in code):
            code = 'BUNDLE_ASSEMBLY_FAILED'
        print(json.dumps({'error': code})); raise SystemExit(1)
