#!/usr/bin/env python3
"""Idempotently provision private, tenant-bound Onyx knowledge agents.

Operational actions remain behind AVA Policy Gateway and are not made public.
This script provisions knowledge reasoning; it does not enable live cutover.
"""
import argparse
import asyncio
import json
import sys

from src.core.onyx_agents_config import build_hotel_sales_agent, build_hotel_manager_agent, build_revenue_agent
from src.core.onyx_client import OnyxClient
from src.core.onyx_db import get_db_connection, init_onyx_tables


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--business-id', type=int, required=True)
    args = parser.parse_args()
    business_id = args.business_id
    with get_db_connection() as conn:
        init_onyx_tables(conn)
        business = conn.execute('SELECT id,name FROM instances WHERE id=? AND isActive=1', (business_id,)).fetchone()
        tenant = conn.execute('SELECT * FROM onyx_tenant_links WHERE business_id=?', (business_id,)).fetchone()
    if not business or not tenant or tenant['status'] not in {'STAGING','ACTIVE','ACTIVE_LIVE'}:
        raise ValueError('A verified active business is required')
    client = OnyxClient(base_url=tenant['onyx_base_url'], credential_ref=tenant['credential_ref'], cc_pair_id=tenant['cc_pair_id'], timeout_seconds=60)
    providers = (await client.request('GET', '/admin/llm/provider')).body['providers']
    provider = next(item for item in providers if item['name'] == f'AVA Hotel {business_id} LLM')
    if provider['is_public']:
        raise ValueError('The tenant LLM provider must be private')
    model = next(item for item in provider['model_configurations'] if item['name'] == f'ava-hotel-{business_id}')
    tools = (await client.request('GET', '/tool')).body
    search = next(item for item in tools if item.get('in_code_tool_id') == 'SearchTool' and item.get('enabled'))
    document_set_name = f'ava-hotel-{business_id}-knowledge'
    sets = (await client.request('GET', '/manage/document-set')).body
    docset = next((item for item in sets if item['name'] == document_set_name), None)
    if docset:
        details = (await client.request('GET', f"/manage/admin/document-set/{docset['id']}")).body
        if details['is_public'] or {item['id'] for item in details['cc_pair_descriptors']} != {tenant['cc_pair_id']}:
            raise ValueError('Existing document set crosses the tenant boundary')
        document_set_id = docset['id']
    else:
        document_set_id = (await client.request('POST', '/manage/admin/document-set', {
            'name': document_set_name, 'description': f'AVA business {business_id}: {business["name"]}',
            'cc_pair_ids': [tenant['cc_pair_id']], 'is_public': False, 'users': [], 'groups': [],
        })).body
    existing = (await client.request('GET', '/persona')).body
    bindings = []
    for role, builder in [('sales', build_hotel_sales_agent), ('manager', build_hotel_manager_agent), ('revenue', build_revenue_agent)]:
        definition = builder(business_id, business['name'])
        name = f'AVA Hotel {business_id} {role}'
        persona = next((item for item in existing if item['name'] == name), None)
        payload = {
            'name': name, 'description': definition.description,
            'document_set_ids': [document_set_id], 'document_ids': [], 'hierarchy_node_ids': [],
            'is_public': False, 'default_model_configuration_id': model['id'],
            'tool_ids': [search['id']], 'system_prompt': definition.instructions,
            'task_prompt': 'Отвечай по-русски. Факты подтверждай цитатами базы текущего отеля. Нельзя обещать выполненную операцию без результата инструмента AVA.',
            'datetime_aware': True,
        }
        result = await client.request('PATCH' if persona else 'POST', f"/persona/{persona['id']}" if persona else '/persona', payload)
        persona_id = result.body['id']
        with get_db_connection() as conn:
            conn.execute('''INSERT INTO onyx_agent_bindings(business_id,role,onyx_base_url,persona_id,document_set_id,
                document_set_name,model_configuration_id,search_tool_id) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(business_id,role) DO UPDATE SET onyx_base_url=excluded.onyx_base_url,
                persona_id=excluded.persona_id,document_set_id=excluded.document_set_id,
                document_set_name=excluded.document_set_name,model_configuration_id=excluded.model_configuration_id,
                search_tool_id=excluded.search_tool_id,updated_at=CURRENT_TIMESTAMP''',
                (business_id,role,tenant['onyx_base_url'],persona_id,document_set_id,document_set_name,model['id'],search['id']))
        bindings.append({'role': role, 'persona_id': persona_id})
    # A private provider is available only to its tenant personas, not all agents.
    await client.request('PUT', '/admin/llm/provider?is_creation=false', {
        'id': provider['id'], 'name': provider['name'], 'provider': provider['provider'],
        'api_base': provider['api_base'], 'api_key_changed': False, 'custom_config_changed': False,
        'is_public': False, 'personas': [item['persona_id'] for item in bindings], 'groups': [],
        'model_configurations': [{'name': model['name'], 'is_visible': True, 'max_input_tokens': 32768,
                                  'supports_image_input': False, 'supports_reasoning': False}],
    })
    print(json.dumps({'business_id': business_id, 'private_document_set_id': document_set_id,
                      'bindings': bindings, 'knowledge_tool_enabled': True,
                      'operational_tools_connected': False, 'live_cutover': False}))


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        print(json.dumps({'error_code': getattr(error, 'code', type(error).__name__),
                          'status_code': getattr(error, 'status_code', None)}), file=sys.stderr)
        raise SystemExit(1)
