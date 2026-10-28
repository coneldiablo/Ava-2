#!/usr/bin/env python3
"""Read-only AVA host snapshot. Run through SSH stdin; prints no credentials or customer content.

python3 script.py is intended on the AVA Linux host, not the macOS checkout.
No load generation, stop, migration, environment output, or configuration mutation.
"""
import json
import os
import re
import sqlite3
import subprocess
import time
import urllib.request
from datetime import datetime, timezone


def command(args):
    return subprocess.check_output(args, text=True, timeout=35)


def main():
    out = {"utc": datetime.now(timezone.utc).isoformat(), "level": "live infrastructure read-only, observed traffic only", "cpus": os.cpu_count(), "loadavg": os.getloadavg()}
    out["memory"] = {}
    for row in open('/proc/meminfo'):
        key, value = row.split(':', 1)
        if key in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
            out['memory'][key] = value.strip()
    out['disks'] = command(['df', '-B1', '/', '/root/ava-current/data']).splitlines()
    out['vmstat'] = command(['vmstat', '1', '3']).splitlines()
    out['pressure'] = {kind: open('/proc/pressure/' + kind).read().strip() for kind in ('cpu', 'memory', 'io')}
    out['containers'] = [json.loads(row) for row in command(['docker', 'stats', '--no-stream', '--format', '{{json .}}']).splitlines()]
    names = [row['Name'] for row in out['containers']]
    ins = json.loads(command(['docker', 'inspect', *names]))
    out['runtime'] = [{'name': row['Name'], 'image': row['Image'], 'running': row['State']['Running'], 'health': row['State'].get('Health', {}).get('Status'), 'oomKilled': row['State']['OOMKilled'], 'restarts': row['RestartCount'], 'started': row['State']['StartedAt'], 'memoryLimit': row['HostConfig']['Memory'], 'pidsLimit': row['HostConfig']['PidsLimit']} for row in ins]
    for label, url in [('crm', 'http://127.0.0.1:3011/api/health'), ('engine', 'http://127.0.0.1:15000/health'), ('public', 'https://wh.meludtech.tech/'), ('auth_config', 'https://wh.meludtech.tech/api/auth/config'), ('public_session', 'https://wh.meludtech.tech/api/auth/me'), ('oidc_discovery', 'https://auth.meludtech.tech/realms/ava/.well-known/openid-configuration')]:
        started = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=12) as response:
                out[label] = {'status': response.status, 'seconds': round(time.monotonic() - started, 4), 'bytes': len(response.read()), 'cache': response.headers.get('Cache-Control'), 'cors': response.headers.get('Access-Control-Allow-Origin')}
        except Exception as error:
            out[label] = {'error': type(error).__name__, 'seconds': round(time.monotonic() - started, 4)}
    out['asterisk_channels'] = command(['asterisk', '-rx', 'core show channels count']).splitlines()
    c = sqlite3.connect('file:/root/ava-current/data/whatsapp_crm/crm_v2.db?mode=ro', uri=True)
    queries = {
        'module_deployments': 'SELECT module,state,count(*),sum(reservedMemoryMiB) FROM ava_module_deployments GROUP BY module,state',
        'module_adapters': 'SELECT module,enabled,count(*) FROM ava_module_adapters GROUP BY module,enabled',
        'onyx_tenant_links': 'SELECT status,count(*),max(last_health_at) FROM onyx_tenant_links GROUP BY status',
        'onyx_sync': 'SELECT status,count(*),max(updated_at) FROM onyx_sync_outbox GROUP BY status',
        'onyx_llm': 'SELECT status,count(*),max(finished_at) FROM onyx_llm_requests GROUP BY status',
        'twenty_links': 'SELECT enabled,mode,connectionStatus,count(*),max(lastSuccessAt) FROM twenty_workspace_links GROUP BY enabled,mode,connectionStatus',
        'twenty_sync': 'SELECT status,count(*),max(updatedAt) FROM twenty_sync_outbox GROUP BY status',
        'twenty_sync_errors': 'SELECT lastErrorCode,count(*) FROM twenty_sync_outbox WHERE lastErrorCode IS NOT NULL GROUP BY lastErrorCode',
        'onyx_sync_errors': 'SELECT last_error_code,count(*) FROM onyx_sync_outbox WHERE last_error_code IS NOT NULL GROUP BY last_error_code',
        'session_counts': 'SELECT CASE WHEN revokedAt IS NULL THEN "not_revoked" ELSE "revoked" END,count(*) FROM ava_sessions GROUP BY revokedAt IS NULL',
        'module_runtime_ownership': 'SELECT id,module,namespace,state,reservedMemoryMiB FROM ava_module_deployments',
    }
    out['database_aggregates'] = {}
    for label, sql in queries.items():
        try:
            out['database_aggregates'][label] = c.execute(sql).fetchall()
        except sqlite3.Error as error:
            out['database_aggregates'][label] = {'error': type(error).__name__}
    c.close()
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
