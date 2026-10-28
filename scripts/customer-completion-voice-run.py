#!/usr/bin/env python3
"""Run only local voice source in an isolated remote interpreter; no file overlay.

Usage: python scripts/customer-completion-voice-run.py [1 [3 [5]]]
Sends public repository source via SSH stdin, never reads/copies credentials.
No production process/config/files/ports are replaced. Output is safe JSON only.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
paths = ['src/providers/neuro_vertex.py', 'src/providers/neuro_speech.py', 'src/audio/audiosocket_server.py', 'src/providers/neuro_gemini.py']
prelude = ['import importlib, logging', 'logging.disable(logging.CRITICAL)']
for path in paths:
    module = path[:-3].replace('/', '.')
    source = (root / path).read_text()
    prelude.append(f'_m=importlib.import_module({module!r})')
    if path.endswith('audiosocket_server.py'):
        # Reuse the existing registered metrics; only replace this class.
        source = source[source.index('class AudioSocketServer:'):]
    prelude.append(f'exec(compile({source!r}, {path!r}, "exec"), vars(_m))')
prelude += ['import src.providers.neuro_gemini as _ng',
            'import src.providers.neuro_vertex as _nv', '_ng.VertexTextClient = _nv.VertexTextClient',
            'import src.providers.neuro_speech as _ns', '_ng.NeuroSpeech = _ns.NeuroSpeech', '_ng.NeuroSpeechError = _ns.NeuroSpeechError']
prelude += ['__voice_probe_source_hashes__ = ' + repr({p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths})]
script = (root / 'scripts/customer-completion-voice-capacity.py').read_text().replace(
    "report = {'level':", "report = {'source_hashes': globals().get('__voice_probe_source_hashes__', {}), 'level':")
command = ['ssh', '-i', '/Users/developer/.ssh/ava-deploy-ed25519', '-o', 'BatchMode=yes',
           'root@203.0.113.10', 'docker exec -i ai_engine python - ' + ' '.join(str(int(v)) for v in sys.argv[1:])]
raise SystemExit(subprocess.run(command, input='\n'.join(prelude)+'\n'+script, text=True).returncode)
