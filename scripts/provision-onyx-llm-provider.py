#!/usr/bin/env python3
"""Register a private Onyx provider using a one-time AVA proxy token on stdin.

Run inside Admin (its existing tenant Onyx credential is resolved from env).
Never supply upstream LLM credentials. This does not enable voice/chat cutover.
"""
import argparse
import asyncio
import json
import re
import sys

from src.core.onyx_client import OnyxClient
from src.core.onyx_db import get_db_connection


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--business-id', type=int, required=True)
    parser.add_argument('--proxy-base-url', required=True)
    parser.add_argument('--test', action='store_true')
    args = parser.parse_args()
    from urllib.parse import urlsplit
    proxy = urlsplit(args.proxy_base_url)
    if args.business_id < 1 or proxy.scheme != 'https' or not proxy.hostname or proxy.username or proxy.password or proxy.query or proxy.fragment:
        raise ValueError('A business and credential-free HTTPS proxy URL are required')
    incoming = json.load(sys.stdin)
    alias = f'ava-hotel-{args.business_id}'
    if incoming.get('model') != alias or not re.fullmatch(r'[A-Za-z0-9_-]{43}', str(incoming.get('token') or '')):
        raise ValueError('Invalid scoped gateway token input')
    with get_db_connection() as conn:
        row = conn.execute('SELECT * FROM onyx_tenant_links WHERE business_id=?', (args.business_id,)).fetchone()
    if not row or row['status'] not in {'STAGING', 'ACTIVE', 'ACTIVE_LIVE'}:
        raise ValueError('Onyx tenant must have a verified connection')
    client = OnyxClient(base_url=row['onyx_base_url'], credential_ref=row['credential_ref'], cc_pair_id=row['cc_pair_id'], timeout_seconds=60)
    name = f'AVA Hotel {args.business_id} LLM'
    providers = (await client.request('GET', '/admin/llm/provider')).body
    if isinstance(providers, dict):
        providers = providers.get('providers')
    if not isinstance(providers, list):
        raise ValueError('Unexpected provider list contract')
    existing = next((provider for provider in providers if provider.get('name') == name), None)
    payload = {
        'name': name, 'provider': 'openai', 'api_key': incoming['token'],
        'api_base': args.proxy_base_url.rstrip('/'), 'api_key_changed': True,
        'is_public': False, 'is_auto_mode': False,
        'personas': existing.get('personas', []) if existing else [],
        'groups': existing.get('groups', []) if existing else [],
        'model_configurations': [{'name': alias, 'is_visible': True, 'max_input_tokens': 32768,
                                  'supports_image_input': False, 'supports_reasoning': False,
                                  'custom_display_name': f'AVA: business {args.business_id}'}],
    }
    if existing:
        payload['id'] = existing['id']
    result = await client.request('PUT', '/admin/llm/provider?is_creation=' + ('false' if existing else 'true'), payload)
    provider_id = result.body['id']
    if args.test:
        await client.request('POST', '/admin/llm/test', {
            'id': provider_id, 'provider': 'openai', 'model': alias,
            'api_base': args.proxy_base_url.rstrip('/'),
            'api_key_changed': False, 'custom_config_changed': False,
        })
    print(json.dumps({'business_id': args.business_id, 'provider_id': provider_id,
                      'model': alias, 'private': True, 'provider_test_ok': bool(args.test),
                      'upstream_credentials_retained_in_ava': True, 'live_cutover': False}))


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        # Exception bodies can contain upstream request data: do not print them.
        print(json.dumps({'error_code': getattr(error, 'code', type(error).__name__),
                          'status_code': getattr(error, 'status_code', None)}), file=sys.stderr)
        raise SystemExit(1)
