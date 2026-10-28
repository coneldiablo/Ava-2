#!/usr/bin/env python3
"""Verify or materialize captured source. Never contacts production or loads env."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name('manifest.json')


def checked_sources(service):
    manifest = json.loads(MANIFEST.read_text())
    services = manifest['services']
    chosen = services if service == 'all' else {service: services[service]}
    checked = []
    for name, entry in chosen.items():
        for relative, record in entry['files'].items():
            destination = Path(relative)
            source = (ROOT / record['source']).resolve()
            if destination.is_absolute() or '..' in destination.parts:
                raise ValueError('Invalid runtime path')
            if not source.is_relative_to(ROOT) or source.is_symlink():
                raise ValueError('Invalid source path')
            if hashlib.sha256(source.read_bytes()).hexdigest() != record['sha256']:
                raise ValueError(f'Source drift: {name}/{relative}')
            checked.append((name, destination, source, record['sha256']))
    return checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['verify', 'materialize'])
    parser.add_argument('--service', choices=['all', 'crm', 'worker', 'engine', 'admin'], default='all')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    rows = checked_sources(args.service)
    if args.mode == 'materialize':
        if not args.output:
            parser.error('materialize requires --output pointing to an empty directory')
        output = args.output.resolve()
        if output == ROOT or output.is_relative_to(ROOT):
            parser.error('output must be outside the source repository')
        if output.exists() and (not output.is_dir() or any(output.iterdir())):
            parser.error('output must be empty')
        output.mkdir(parents=True, exist_ok=True)
        for service, relative, source, digest in rows:
            target = output / service / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError('Materialized source drift')
    print(json.dumps({'status': 'PASS', 'mode': args.mode, 'files': len(rows),
                      'services': sorted({row[0] for row in rows}),
                      'scope': 'source integrity only; environment, DB, dependencies and provider acceptance excluded'}))


if __name__ == '__main__':
    main()
