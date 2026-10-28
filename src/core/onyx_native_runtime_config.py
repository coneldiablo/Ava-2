"""Root-mounted native routes and durable admission; never request/model data."""
from __future__ import annotations

from collections.abc import Mapping
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
from urllib.parse import urlsplit
from uuid import UUID

from src.core.onyx_client import OnyxClientError
from src.core.onyx_db import get_db_connection
from src.core.onyx_native_runtime_client import normalize_private_gateway_origin

_DOCKER_GATEWAY = re.compile(r'^ava_([0-9a-f]{32})-gateway-1$')
_PEER_SECRET = re.compile(r'^[A-Za-z0-9_-]{43}$')


def _invalid():
    return OnyxClientError('Native runtime configuration unavailable',
                           code='ONYX_NATIVE_RUNTIME_CONFIG_INVALID', status_code=503)


def native_runtime_config(business_id: int):
    root = os.getenv('AVA_ONYX_NATIVE_RUNTIME_DIRECTORY')
    if not root:
        return None
    if type(business_id) is not int or business_id < 1:
        raise _invalid()
    directory_fd = None
    try:
        directory = Path(root)
        if not directory.is_absolute():
            raise ValueError()
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(directory_fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 1000
                or info.st_mode & 0o027):
            raise ValueError()
        try:
            fd = os.open(f'{business_id}.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=directory_fd)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 1000
                    or stat.S_IMODE(info.st_mode) != 0o440 or not 0 < info.st_size <= 4096):
                raise ValueError()
            raw = os.read(fd, 4097)
            if len(raw) > 4096:
                raise ValueError()
            value = json.loads(raw)
        finally:
            os.close(fd)
        if (not isinstance(value, dict) or type(value.get('business_id')) is not int
                or value['business_id'] != business_id):
            raise ValueError()
        return {key: item for key, item in value.items() if key != 'business_id'}
    except (OSError, ValueError, TypeError):
        raise _invalid() from None
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def native_runtime_scope(db_path, business_id: int, provider=native_runtime_config, *, role='sales'):
    """None alone selects legacy. Any configured route must pass every fence.

    This performs no migrations. The returned private configuration stays
    inside AVA and must never be serialized into a public response or log.
    """
    if type(business_id) is not int or business_id < 1:
        raise _invalid()
    try:
        config = provider(business_id) if provider is not None else None
    except OnyxClientError:
        raise
    except Exception:
        raise _invalid() from None
    if config is None:
        return None
    required = {'enabled', 'deployment_id', 'deployment_revision', 'private_gateway_origin', 'runtime_peer_secret'}
    if (not isinstance(config, Mapping) or set(config) != required or config['enabled'] is not True
            or not isinstance(config['deployment_id'], str)
            or type(config['deployment_revision']) is not int or config['deployment_revision'] < 1
            or not isinstance(config['private_gateway_origin'], str)
            or not isinstance(config['runtime_peer_secret'], str)
            or not _PEER_SECRET.fullmatch(config['runtime_peer_secret'])):
        raise _invalid()
    try:
        deployment_id = str(UUID(config['deployment_id']))
        origin = normalize_private_gateway_origin(config['private_gateway_origin'])
    except (OnyxClientError, ValueError, TypeError, AttributeError):
        raise _invalid() from None
    gateway = _DOCKER_GATEWAY.fullmatch(urlsplit(origin).hostname or '')
    if gateway and gateway.group(1) != deployment_id.replace('-', ''):
        raise _invalid()
    try:
        with closing(get_db_connection(db_path, readonly=True)) as conn:
            row = conn.execute('''SELECT d.namespace,a.id AS adapter_id,a.revision AS adapter_revision,
                a.integrationRevision AS integration_revision,b.persona_id,b.document_set_name,b.search_tool_id
                FROM instances i
                JOIN ava_module_deployments d ON d.businessId=i.id
                JOIN ava_module_adapters a ON a.businessId=i.id AND a.module='onyx'
                JOIN ava_onyx_runtime_principals p ON p.businessId=i.id AND p.adapterId=a.id
                JOIN onyx_tenant_links t ON t.business_id=i.id
                JOIN onyx_native_runtime_bindings b ON b.business_id=i.id
                WHERE i.id=? AND i.isActive=1
                  AND d.id=? AND d.module='onyx' AND d.state='verified' AND d.revision=?
                  AND a.enabled=1 AND a.attachmentMode='existing_workspace_ui'
                  AND a.attachmentModeV2='isolated_workspace_ui'
                  AND a.deploymentId=d.id AND a.deploymentRevision=d.revision AND a.nativeScope=d.namespace
                  AND p.revokedAt IS NULL AND p.adapterRevision=a.revision
                  AND p.deploymentId=d.id AND p.deploymentRevision=d.revision
                  AND p.integrationRevision=a.integrationRevision AND p.nativeScope=a.nativeScope
                  AND t.id=a.integrationId AND t.revision=a.integrationRevision AND t.status<>'DISABLED'
                  AND b.deployment_id=d.id AND b.deployment_revision=d.revision AND b.role=?
                LIMIT 1''', (business_id, deployment_id, config['deployment_revision'], role)).fetchone()
    except sqlite3.Error:
        row = None
    if not row:
        raise OnyxClientError('Native runtime is not admitted for this business',
                              code='ONYX_NATIVE_RUNTIME_NOT_READY', status_code=503)
    binding = {key: row[key] for key in ('persona_id', 'document_set_name', 'search_tool_id')}
    if (row['namespace'] != 'ava_' + deployment_id.replace('-', '')
            or any(type(row[key]) is not int or row[key] < 1 for key in ('adapter_revision', 'integration_revision'))
            or binding['document_set_name'] != 'ava-native-' + deployment_id.replace('-', '') + '-knowledge'
            or type(binding['persona_id']) is not int or binding['persona_id'] < 1
            or type(binding['search_tool_id']) is not int or binding['search_tool_id'] < 1):
        raise OnyxClientError('Native runtime binding is invalid',
                              code='ONYX_NATIVE_RUNTIME_NOT_READY', status_code=503)
    return {'config': {**config, 'deployment_id': deployment_id, 'private_gateway_origin': origin},
            'binding': binding, 'admission': {key: row[key] for key in (
                'namespace', 'adapter_id', 'adapter_revision', 'integration_revision')}}
