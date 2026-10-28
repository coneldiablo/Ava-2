#!/usr/bin/env python3
"""Move one existing AVA business to verified aliases of the SAME backend.

Not a general connector reconfiguration: only the literal single-host IP to
public-domain aliases below are accepted. Before --apply, create an online
SQLite recovery snapshot and verify the same authenticated Onyx user/cc-pair
and the same scoped Twenty record through both addresses. No credentials,
workspace mappings, acceptance status, agents or execution scopes are reset.
"""
import argparse
import json
import sqlite3


ALIASES = (
    ('onyx_tenant_links', 'business_id', 'onyx_base_url',
     'https://203.0.113.10/api', 'https://knowledge.meludtech.tech/api'),
    ('onyx_agent_bindings', 'business_id', 'onyx_base_url',
     'https://203.0.113.10/api', 'https://knowledge.meludtech.tech/api'),
    ('onyx_mcp_tool_bindings', 'business_id', 'onyx_base_url',
     'https://203.0.113.10/api', 'https://knowledge.meludtech.tech/api'),
    ('twenty_workspace_links', 'businessId', 'baseUrl',
     'https://203.0.113.10:8443', 'https://crm.meludtech.tech'),
)


def migrate(conn, business_id, cc_pair_id, workspace_id, *, apply=False):
    if type(business_id) is not int or business_id < 1:
        raise ValueError('business_id must be positive')
    conn.execute('BEGIN IMMEDIATE')
    try:
        business = conn.execute('SELECT isActive FROM instances WHERE id=?', (business_id,)).fetchone()
        tenant = conn.execute('SELECT cc_pair_id FROM onyx_tenant_links WHERE business_id=?', (business_id,)).fetchone()
        workspace = conn.execute('SELECT workspaceId FROM twenty_workspace_links WHERE businessId=?', (business_id,)).fetchone()
        if not business or business[0] != 1 or not tenant or tenant[0] != cc_pair_id or not workspace or workspace[0] != workspace_id:
            raise ValueError('Active business or verified backend identity changed')
        changes = {}
        for table, scope, column, old, new in ALIASES:
            rows = conn.execute(f'SELECT {column} FROM {table} WHERE {scope}=?', (business_id,)).fetchall()
            if any(row[0] not in {old, new} for row in rows):
                raise ValueError(f'Unexpected backend in {table}; no changes applied')
            changes[table] = conn.execute(
                f'UPDATE {table} SET {column}=? WHERE {scope}=? AND {column}=?',
                (new, business_id, old),
            ).rowcount
        if apply:
            conn.commit()
        else:
            conn.rollback()
        return {'business_id': business_id, 'applied': apply, 'changed_rows': changes}
    except Exception:
        conn.rollback()
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    parser.add_argument('--business-id', type=int, required=True)
    parser.add_argument('--cc-pair-id', type=int, required=True)
    parser.add_argument('--workspace-id', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    with sqlite3.connect(f'file:{args.db}?mode=rw', uri=True, timeout=30) as conn:
        result = migrate(conn, args.business_id, args.cc_pair_id, args.workspace_id, apply=args.apply)
    print(json.dumps(result))
