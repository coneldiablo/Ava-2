#!/usr/bin/env python3
"""Read bounded, redacted logs from one validated disposable Onyx project."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess

spec = importlib.util.spec_from_file_location('onyx_qa', Path(__file__).with_name('run-onyx-recipe-qa.py'))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def redact(text, secrets):
    for value in sorted(secrets.values(), key=len, reverse=True):
        if value:
            text = text.replace(value, '[REDACTED]')
    text = re.sub(r'(?i)(Bearer|Basic)\s+\S+', r'\1 [REDACTED]', text)
    text = re.sub(r'(\w+://)[^\s/@]+:[^\s/@]+@', r'\1[REDACTED]@', text)
    text = re.sub(r'(?i)(["\x27]?(?:password|secret|api[_-]?key|access[_-]?token)["\x27]?\s*[:=]\s*)[^\s,;]+', r'\1[REDACTED]', text)
    return re.sub(r'\x1b\[[0-9;]*m', '', text)


def inspect(directory, services):
    directory = qa._scope(directory)
    manifest = qa._load_manifest(directory)
    row = manifest['row']
    launcher = qa.helper.Deployments(directory / 'synthetic.sqlite', directory)
    root, _recipe, compose = launcher._recipe(row)
    launcher._state(row, compose)  # Reject foreign containers/image/labels.
    containers = qa._containers(launcher, row)
    if not services or len(services) != len(set(services)) or any(name not in compose['services'] for name in services):
        raise ValueError('QA_SERVICE_REQUIRED')
    _, secrets = qa.helper.private_json(root / 'secrets.json')
    if not secrets or any(not isinstance(value, str) or len(value) < 32 for value in secrets.values()):
        raise ValueError('QA_SECRET_INVENTORY_REQUIRED')
    output = []
    for name in services:
        container = containers.get(name)
        if container is None:
            output.append({'service': name, 'status': 'absent'})
            continue
        state = container.get('State', {})
        result = subprocess.run(['docker', 'logs', '--tail', '100', container['Id']],
                                capture_output=True, text=True, timeout=15, env=qa.helper.SAFE_ENV)
        text = redact(result.stdout + result.stderr, secrets)
        lines = text.splitlines()
        # Prefer causal error lines over a long tail of repeated stack frames.
        errors = [line for line in lines if re.search(r'exception|error|denied|read-only|failed|caused by', line, re.I)]
        output.append({'service': name, 'status': state.get('Status'), 'exit_code': state.get('ExitCode'),
                       'oom_killed': state.get('OOMKilled'), 'restarts': container.get('RestartCount'),
                       'health': state.get('Health', {}).get('Status'),
                       'log': '\n'.join(errors[-12:] if errors else lines[-18:])[-4500:]})
    return {'qa_only': True, 'read_only': True, 'deployment_id': row['id'], 'services': output}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--services', required=True, nargs='+')
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.directory, args.services)))
    except Exception:
        raise SystemExit('ONYX_QA_INSPECTION_FAILED') from None
