#!/usr/bin/env python3
"""Disable redundant Onyx workspace filter inference; retain explicit ACL filters.

This is a workspace setting, not a per-hotel override. AVA already pins the
private document set and business metadata. No live-cutover flags are changed.
Default is read-only. --apply requires an exclusive, private backup filename.
"""
import argparse
import asyncio
import json
import os

from src.core.onyx_client import OnyxClient
from src.core.onyx_db import get_db_connection


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--business-id', type=int, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup')
    args = parser.parse_args()
    with get_db_connection() as conn:
        tenant = conn.execute('SELECT * FROM onyx_tenant_links WHERE business_id=?', (args.business_id,)).fetchone()
    if not tenant:
        raise ValueError('Missing verified Onyx link')
    client = OnyxClient(base_url=tenant['onyx_base_url'], credential_ref=tenant['credential_ref'], cc_pair_id=tenant['cc_pair_id'])
    before = (await client.request('GET', '/settings')).body
    previous = before.get('auto_detect_search_filters')
    if args.apply:
        if not args.backup:
            raise ValueError('A private backup path is required')
        fd = os.open(args.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            json.dump(before, file, ensure_ascii=False)
        await client.request('PATCH', '/admin/settings', {'auto_detect_search_filters': False})
    after = (await client.request('GET', '/settings')).body
    if args.apply and after.get('auto_detect_search_filters') is not False:
        raise ValueError('Settings did not persist')
    print(json.dumps({'workspace_setting': True, 'before': previous,
                      'after': after.get('auto_detect_search_filters'), 'applied': args.apply,
                      'explicit_tenant_filters_unchanged': True, 'live_cutover': False}))


if __name__ == '__main__':
    asyncio.run(main())
