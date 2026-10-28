#!/usr/bin/env python3
"""Provision the generic READ catalog; hotel data needs an AVA execution scope.

Onyx Community shares the catalog, not data authorization. A discovery key
cannot read customer/hotel data. The trusted AVA runner issues an additional
180-second, tenant/role/customer-bound capability for every reasoning request.
No credentials are printed and this script does not enable live cutover.
"""
import argparse
import asyncio
import json
import sys
from urllib.parse import urlsplit

from src.core.onyx_client import OnyxClient
from src.core.onyx_db import get_db_connection, init_onyx_tables
from src.core.onyx_mcp_bridge import OnyxMcpBridge, READ_ACTIONS
from src.core.onyx_policy_gateway import PolicyGateway


def persona_payload(persona, binding, tool_ids):
    """Preserve the operator's prompt and attachments, fail closed on scope."""
    if (persona['is_public'] or persona['name'] != f"AVA Hotel {binding['business_id']} {binding['role']}"
            or {item['id'] for item in persona['document_sets']} != {binding['document_set_id']}
            or persona['default_model_configuration_id'] != binding['model_configuration_id']):
        raise ValueError('Persona scope changed; review before provisioning')
    return {
        'name': persona['name'], 'description': persona['description'],
        'document_set_ids': [binding['document_set_id']], 'is_public': False,
        'default_model_configuration_id': binding['model_configuration_id'],
        'tool_ids': [binding['search_tool_id'], *tool_ids],
        'system_prompt': persona['system_prompt'] or '', 'task_prompt': persona['task_prompt'] or '',
        'replace_base_system_prompt': persona['replace_base_system_prompt'], 'datetime_aware': persona['datetime_aware'],
        'hierarchy_node_ids': [item['id'] for item in persona.get('hierarchy_nodes', [])],
        'document_ids': [item['id'] for item in persona.get('attached_documents', [])],
        'user_file_ids': persona.get('user_file_ids', []), 'starter_messages': persona.get('starter_messages'),
        'uploaded_image_id': persona.get('uploaded_image_id'), 'icon_name': persona.get('icon_name'),
        'label_ids': [item['id'] for item in persona.get('labels', [])],
    }


async def provision(business_id, server_url, *, rotate_discovery=False, db_path=None, client_factory=OnyxClient):
    url = urlsplit(server_url)
    if (type(business_id) is not int or business_id < 1 or url.scheme != 'https' or not url.hostname
            or url.username or url.password or url.query or url.fragment or url.path != '/api/integrations/onyx/mcp'):
        raise ValueError('A positive business and credential-free HTTPS MCP endpoint are required')
    with get_db_connection(db_path) as conn:
        init_onyx_tables(conn)
        tenant = conn.execute('''SELECT t.* FROM onyx_tenant_links t JOIN instances i ON i.id=t.business_id
            WHERE t.business_id=? AND i.isActive=1''', (business_id,)).fetchone()
        bindings = [dict(row) for row in conn.execute('SELECT * FROM onyx_agent_bindings WHERE business_id=? ORDER BY role', (business_id,))]
        credential = conn.execute('SELECT token_hash FROM onyx_mcp_discovery_credentials WHERE id=1').fetchone()
    if not tenant or tenant['status'] not in {'STAGING','ACTIVE','ACTIVE_LIVE'} or not bindings:
        raise ValueError('A verified tenant with private agents is required')
    if any(binding['onyx_base_url'] != tenant['onyx_base_url'] for binding in bindings):
        raise ValueError('Stale agent bindings')
    client = client_factory(base_url=tenant['onyx_base_url'], credential_ref=tenant['credential_ref'],
                           cc_pair_id=tenant['cc_pair_id'], timeout_seconds=60)
    # Validate every persona before rotating shared discovery or changing tools.
    personas = {}
    for binding in bindings:
        persona = (await client.request('GET', f"/persona/{binding['persona_id']}")).body
        persona_payload(persona, binding, [])
        personas[binding['role']] = persona
    servers = (await client.request('GET', '/admin/mcp/servers')).body['mcp_servers']
    matching = [item for item in servers if item['name'] == 'AVA Read Actions']
    if len(matching) > 1:
        raise ValueError('Duplicate AVA MCP servers require review')
    existing = matching[0] if matching else None
    if existing and existing['server_url'] != server_url:
        raise ValueError('Existing MCP URL changed; review before provisioning')
    server_id = existing['id'] if existing else None
    if not existing or not credential or rotate_discovery:
        token = OnyxMcpBridge(db_path).issue_discovery_token()
        payload = {'name': 'AVA Read Actions', 'description': 'Generic read-only catalog. Data access requires a short-lived AVA execution capability.',
                   'server_url': server_url, 'auth_type': 'API_TOKEN', 'auth_performer': 'ADMIN',
                   'api_token': token, 'api_token_changed': True, 'transport': 'STREAMABLE_HTTP', 'is_public': True}
        if existing:
            payload['existing_server_id'] = server_id
        server_id = (await client.request('POST', '/admin/mcp/servers/create', payload)).body['server_id']
    snapshots = (await client.request('GET', f'/admin/mcp/server/{server_id}/tools/snapshots?source=mcp')).body
    if not isinstance(snapshots, list) or {tool['name'] for tool in snapshots} != READ_ACTIONS:
        raise ValueError('MCP schema changed: READ-only catalog required')
    if any(tool['mcp_server_id'] != server_id for tool in snapshots):
        raise ValueError('MCP tool server mismatch')
    await client.request('POST', '/admin/mcp/servers/update', {'server_id': server_id, 'selected_tools': sorted(READ_ACTIONS)})
    tools = {tool['name']: tool['id'] for tool in snapshots}
    connected = []
    for binding in bindings:
        allowed = sorted(READ_ACTIONS & PolicyGateway.ROLE_ACTIONS[binding['role']])
        payload = persona_payload(personas[binding['role']], binding, [tools[name] for name in allowed])
        updated = (await client.request('PATCH', f"/persona/{binding['persona_id']}", payload)).body
        if updated['is_public'] or {tool['id'] for tool in updated['tools']} != set(payload['tool_ids']):
            raise ValueError('Onyx did not preserve private read-only agent tools')
        with get_db_connection(db_path) as conn:
            conn.execute('DELETE FROM onyx_mcp_tool_bindings WHERE business_id=? AND agent_role=?', (business_id, binding['role']))
            conn.executemany('''INSERT INTO onyx_mcp_tool_bindings
                (business_id,agent_role,onyx_base_url,mcp_server_id,tool_name,tool_id) VALUES (?,?,?,?,?,?)''',
                [(business_id, binding['role'], tenant['onyx_base_url'], server_id, name, tools[name]) for name in allowed])
        connected.append({'role': binding['role'], 'persona_id': binding['persona_id'], 'read_tools': allowed})
    return {'business_id': business_id, 'mcp_server_id': server_id, 'agents': connected,
            'data_access_requires_ava_execution_scope': True, 'write_tools_enabled': False, 'live_cutover': False}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--business-id', type=int, required=True)
    parser.add_argument('--server-url', required=True)
    parser.add_argument('--rotate-discovery', action='store_true')
    args = parser.parse_args()
    print(json.dumps(await provision(args.business_id, args.server_url, rotate_discovery=args.rotate_discovery)))


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        print(json.dumps({'error_code': getattr(error, 'code', type(error).__name__),
                          'status_code': getattr(error, 'status_code', None)}), file=sys.stderr)
        raise SystemExit(1)
