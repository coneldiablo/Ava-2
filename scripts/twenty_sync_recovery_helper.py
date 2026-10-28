"""Privileged, whole-contour recovery for an abandoned Twenty sync operation.

Only the worker Unix socket may invoke this. Request data cannot select a
container, command, path, service, recipe, or proof. The helper reads the durable
claim independently and leaves the sync barrier active on every failure.
"""
from datetime import datetime
import fcntl
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time

import module_deployment_helper as helper


CONTRACT = 'ava-sync-recovery-v1'
FIELDS = frozenset(('contractVersion', 'recoveryId', 'recoveryToken', 'leaseId',
                   'deploymentId', 'businessId', 'leaseRevision', 'deploymentRevision',
                   'adapterRevision', 'integrationRevision', 'correlationId', 'outboxEventId'))
IDS = ('recoveryId', 'recoveryToken', 'leaseId', 'deploymentId')
NUMBERS = ('businessId', 'leaseRevision', 'deploymentRevision', 'adapterRevision', 'integrationRevision')
EVENT = re.compile(r'(?:twout_)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')


def validate_request(value):
    if not isinstance(value, dict) or set(value) != FIELDS or value['contractVersion'] != CONTRACT:
        helper.reject('SYNC_RECOVERY_REQUEST_INVALID')
    if any(not isinstance(value[key], str) or not helper.UUID.fullmatch(value[key]) for key in IDS):
        helper.reject('SYNC_RECOVERY_REQUEST_INVALID')
    if any(type(value[key]) is not int or value[key] < 1 for key in NUMBERS):
        helper.reject('SYNC_RECOVERY_REQUEST_INVALID')
    if any(not isinstance(value[key], str) or not EVENT.fullmatch(value[key]) for key in ('correlationId', 'outboxEventId')):
        helper.reject('SYNC_RECOVERY_REQUEST_INVALID')
    return value


def timestamp_ms(value, allow_absent=False):
    if allow_absent and (value is None or value == '0001-01-01T00:00:00Z'):
        return None
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', value):
        helper.reject('SYNC_RECOVERY_INSPECTION_INVALID')
    try:
        result = int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, OverflowError):
        helper.reject('SYNC_RECOVERY_INSPECTION_INVALID')
    if result <= 0:
        helper.reject('SYNC_RECOVERY_INSPECTION_INVALID')
    return result


class SyncRecovery:
    def __init__(self, deployments, sleeper=time.sleep, monotonic=time.monotonic):
        self.deployments = deployments
        self.sleep, self.monotonic = sleeper, monotonic

    def claim(self, payload):
        validate_request(payload)
        now = int(self.deployments.clock() * 1000)
        with sqlite3.connect(f'{self.deployments.database.as_uri()}?mode=ro', uri=True, timeout=5) as db:
            db.row_factory = sqlite3.Row
            db.execute('BEGIN')
            def one(table, field, value):
                # Table/field names come only from the fixed source below.
                row = db.execute(f'SELECT * FROM {table} WHERE {field}=?', (value,)).fetchone()
                if row is None: helper.reject('SYNC_RECOVERY_CLAIM_LOST')
                return dict(row)
            recovery = one('ava_sync_lease_recoveries', 'recoveryId', payload['recoveryId'])
            lease = one('ava_sync_leases', 'leaseId', payload['leaseId'])
            deployment = one('ava_module_deployments', 'id', payload['deploymentId'])
            adapter = one('ava_module_adapters', 'id', lease['adapterId'])
            business = one('instances', 'id', payload['businessId'])
            link = one('twenty_workspace_links', 'businessId', payload['businessId'])
            mutation = one('ava_sync_mutations', 'correlationId', payload['correlationId'])
            outbox = one('twenty_sync_outbox', 'eventId', payload['outboxEventId'])
        if any(recovery.get(key) != payload[key] for key in FIELDS - {'contractVersion', 'recoveryToken'}):
            helper.reject('SYNC_RECOVERY_CLAIM_LOST')
        token_hash = hashlib.sha256(payload['recoveryToken'].encode('ascii')).hexdigest()
        if (recovery['state'] != 'leased' or (recovery['leasedUntil'] or 0) <= now
                or not isinstance(recovery['tokenHash'], str)
                or not hmac.compare_digest(recovery['tokenHash'], token_hash)):
            helper.reject('SYNC_RECOVERY_CLAIM_LOST')
        # Disable/replacement forbids an automatic restart. Such a deployment
        # needs a separate stop-only lifecycle, never a resurrection here.
        if (business['isActive'] != 1 or adapter['enabled'] != 1 or link['enabled'] != 1
                or deployment['state'] != 'verified'
                or deployment['module'] != 'twenty' or adapter['module'] != 'twenty'
                or deployment['revision'] != payload['deploymentRevision']
                or adapter['revision'] != payload['adapterRevision']
                or link['revision'] != payload['integrationRevision']
                or adapter['integrationRevision'] != link['revision']
                or adapter['deploymentRevision'] != deployment['revision']
                or adapter['deploymentId'] != deployment['id']
                or adapter['publicOrigin'] != 'https://' + deployment['hostname']
                or adapter['integrationId'] != link['id']
                or adapter['nativeScope'] != link['workspaceId']
                or any(item['businessId'] != payload['businessId'] for item in (lease, deployment, adapter, link, mutation, outbox))):
            helper.reject('SYNC_RECOVERY_SCOPE_CHANGED')
        if (lease['status'] != 'active' or lease['deploymentId'] != deployment['id']
                or lease['nativeScope'] != adapter['nativeScope'] or lease['revision'] != payload['leaseRevision']
                or lease['revision'] != deployment['revision']
                or lease['correlationId'] != payload['correlationId']
                or (lease['expiresAt'] > now and lease['outcome'] not in ('abandoned_pending_death', 'disable_pending'))):
            helper.reject('SYNC_RECOVERY_NOT_ELIGIBLE')
        if (mutation['adapterId'] != adapter['id'] or mutation['deploymentId'] != deployment['id']
                or mutation['nativeScope'] != lease['nativeScope'] or mutation['revision'] != lease['revision']
                or mutation['integrationRevision'] != link['revision']
                or mutation['outboxLeaseHash'] != recovery['outboxLeaseHash']
                or any(mutation[key] != lease[key] for key in ('method', 'path', 'objectName', 'recordId', 'bodyDigest'))
                or any(str(outbox[key]) != str(recovery['outbox' + key[0].upper() + key[1:]])
                       for key in ('entityType', 'sourceTable', 'sourceId', 'operation'))):
            helper.reject('SYNC_RECOVERY_BINDING_CHANGED')
        # The worker atomically freezes this exact outbox with its recovery
        # claim. No live producer lease may coexist with a supervisor stop.
        if outbox['status'] != 'FAILED' or outbox['leaseToken'] is not None or outbox['leasedUntil'] is not None:
            helper.reject('SYNC_RECOVERY_BINDING_CHANGED')
        return deployment

    def snapshot(self, row, compose):
        self.deployments._state(row, compose)  # complete project/label/image ownership check
        items = self.deployments._containers(row['id'])
        names = [item.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') for item in items]
        if len(names) != len(set(names)) or set(names) != set(compose['services']):
            helper.reject('SYNC_RECOVERY_INSPECTION_INVALID')
        result = {}
        for item, name in zip(items, names):
            state = item.get('State', {})
            pid, running, restarting = state.get('Pid'), state.get('Running'), state.get('Restarting')
            if (not re.fullmatch(r'[0-9a-f]{64}', item.get('Id', '')) or type(pid) is not int or pid < 0
                    or type(running) is not bool or type(restarting) is not bool
                    or (running and pid == 0) or (not running and pid != 0)):
                helper.reject('SYNC_RECOVERY_INSPECTION_INVALID')
            result[name] = {'containerId': item['Id'], 'running': running, 'restarting': restarting,
                            'pid': pid, 'startedAt': timestamp_ms(state.get('StartedAt'), allow_absent=not running),
                            'health': state.get('Health', {}).get('Status'), 'exitCode': state.get('ExitCode')}
        return result

    def execute(self, payload):
        row = self.claim(payload)
        # Recovery cannot allocate a new recipe or deployment as a side effect.
        root = self.deployments.recipes / row['id']
        helper.owned_path(root / 'recipe.json')
        helper.owned_path(root / 'compose.json')
        root, recipe, compose = self.deployments._recipe(row)
        if not {'database', 'native'}.issubset(compose['services']) or any(
                not compose['services'][name].get('healthcheck') for name in ('database', 'native')):
            helper.reject('SYNC_RECOVERY_RECIPE_REQUIRED')
        lock = os.open(root / '.launch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: helper.reject('DEPLOYMENT_HELPER_BUSY')
            self.claim(payload)
            command = ['docker', 'compose', '--project-name', row['namespace'], '--project-directory', str(root),
                       '--env-file', '/dev/null', '-f', str(root / 'compose.json')]
            self.deployments.runner([*command, 'config', '--quiet'], timeout=20)
            before = self.snapshot(row, compose)
            self.claim(payload)
            self.deployments.runner([*command, 'stop', '--timeout', '10'], timeout=60)
            stopped = self.snapshot(row, compose)
            if any(stopped[name]['containerId'] != before[name]['containerId']
                   or stopped[name]['running'] or stopped[name]['restarting'] or stopped[name]['pid'] != 0 for name in before):
                helper.reject('SYNC_RECOVERY_STOP_UNPROVEN')
            stopped_at = int(self.deployments.clock() * 1000)
            self.claim(payload)
            try:
                self.deployments.runner([*command, 'up', '--detach', '--no-build', '--pull', 'never', '--no-recreate'], timeout=180)
                deadline = self.monotonic() + 90
                while True:
                    self.claim(payload)
                    after = self.snapshot(row, compose)
                    initializers = set(recipe.get('initServices', []))
                    ready = True
                    for name, state in after.items():
                        if state['containerId'] != before[name]['containerId']:
                            helper.reject('SYNC_RECOVERY_INSPECTION_INVALID')
                        if name in initializers:
                            ready = ready and not state['running'] and not state['restarting'] and state['pid'] == 0 and state['exitCode'] == 0
                        else:
                            ready = ready and state['running'] and not state['restarting'] and state['pid'] > 0 \
                                and state['startedAt'] is not None and state['startedAt'] > stopped_at
                            if compose['services'][name].get('healthcheck'):
                                ready = ready and state['health'] == 'healthy'
                    if ready: break
                    if self.monotonic() >= deadline: helper.reject('SYNC_RECOVERY_RESTART_UNPROVEN')
                    self.sleep(1)
                # Query the actual postmaster after restart, without exposing
                # a password or connection URI in argv/output. Native/local PG
                # roles come exclusively from the reviewed container env.
                sql = "SELECT json_build_object('recovered',NOT pg_is_in_recovery(),'startedAt',floor(extract(epoch from pg_postmaster_start_time())*1000)::bigint)"
                script = 'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password --tuples-only --no-align --command="' + sql + '"'
                raw = self.deployments.runner(['docker', 'exec', after['database']['containerId'], 'sh', '-ec', script], timeout=15)
                try: database = json.loads(raw)
                except (ValueError, TypeError): helper.reject('SYNC_RECOVERY_DATABASE_UNPROVEN')
                if (not isinstance(database, dict) or set(database) != {'recovered', 'startedAt'} or database['recovered'] is not True
                        or type(database['startedAt']) is not int or database['startedAt'] <= stopped_at):
                    helper.reject('SYNC_RECOVERY_DATABASE_UNPROVEN')
                self.claim(payload)
                # No unexpected restart occurred during the SQL/native probe.
                if self.snapshot(row, compose) != after:
                    helper.reject('SYNC_RECOVERY_RESTART_UNPROVEN')
            except Exception:
                # Even a failed start can create running services after revoke.
                # Never stop an unverified foreign replacement project.
                latest = self.snapshot(row, compose)
                if all(latest[name]['containerId'] == before[name]['containerId'] for name in before):
                    self.deployments.runner([*command, 'stop', '--timeout', '10'], timeout=60)
                raise
            completed = int(self.deployments.clock() * 1000)
            containers = []
            for name in sorted(before):
                a, b, c = before[name], stopped[name], after[name]
                containers.append({'service': name, 'containerId': a['containerId'],
                    'beforeRunning': a['running'], 'beforeRestarting': a['restarting'], 'beforePid': a['pid'], 'beforeStartedAt': a['startedAt'],
                    'stoppedRunning': b['running'], 'stoppedRestarting': b['restarting'], 'stoppedPid': b['pid'],
                    'afterRunning': c['running'], 'afterRestarting': c['restarting'], 'afterPid': c['pid'], 'afterStartedAt': c['startedAt'],
                    'health': 'exited' if name in initializers else (c['health'] or 'running')})
            return {**{key: value for key, value in payload.items() if key != 'recoveryToken'},
                    'namespace': row['namespace'], 'sourceCommit': row['sourceCommit'], 'project': row['namespace'],
                    'stopObservedAt': stopped_at, 'ownedContainerIds': sorted(v['containerId'] for v in before.values()),
                    'stoppedContainerIds': sorted(v['containerId'] for v in stopped.values()), 'containers': containers,
                    'database': {'containerId': after['database']['containerId'], 'postmasterStartedAt': database['startedAt'],
                                 'recoveryCompletedAt': completed, 'readyAt': completed},
                    'native': {'containerId': after['native']['containerId'], 'readyAt': completed}, 'completedAt': completed}
        finally:
            os.close(lock)
