#!/usr/bin/env python3
"""Run the bounded pilot proof inside its read-only auth container.

Only a non-secret operator manifest and verifier source enter container tmpfs.
Peer credentials remain in their existing container mounts.
"""
import json
from pathlib import Path
import subprocess

ROOT = Path('/opt/ava-build/onyx-entry-crm-20260918')
MANIFEST = Path('/opt/ava-deploy/onyx-customer-entry-1/operator.json')
CONTAINER = 'ava_efd976252605416f8a9eb2f39efb54ef-auth-1'
BOOTSTRAP = '''
import json, os, sys, tempfile
from pathlib import Path
payload = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="ava-entry-proof-") as directory:
    manifest = Path(directory) / "operator.json"
    manifest.write_text(json.dumps(payload["manifest"]))
    manifest.chmod(0o600)
    sys.argv = ["verify-entry.py", "--run", "--operator-manifest", str(manifest)]
    exec(compile(payload["source"], "verify-entry.py", "exec"), {"__name__": "__main__"})
'''

if __name__ == '__main__':
    payload = {'manifest': json.loads(MANIFEST.read_text()),
               'source': (ROOT / 'verify-onyx-customer-entry.py').read_text()}
    result = subprocess.run(['docker', 'exec', '-i', CONTAINER, 'python', '-c', BOOTSTRAP],
                            input=json.dumps(payload).encode(), timeout=180)
    raise SystemExit(result.returncode)
