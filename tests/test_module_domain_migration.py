import importlib.util
from pathlib import Path
import sqlite3

import pytest


spec = importlib.util.spec_from_file_location('module_domains', Path(__file__).parents[1] / 'scripts/migrate-ava-module-domains.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def db():
    conn = sqlite3.connect(':memory:')
    conn.executescript('''
        CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER);
        CREATE TABLE onyx_tenant_links(business_id INTEGER PRIMARY KEY,onyx_base_url TEXT,cc_pair_id INTEGER,status TEXT,credential_ref TEXT);
        CREATE TABLE onyx_agent_bindings(business_id INTEGER,onyx_base_url TEXT,persona_id INTEGER);
        CREATE TABLE onyx_mcp_tool_bindings(business_id INTEGER,onyx_base_url TEXT,tool_id INTEGER);
        CREATE TABLE twenty_workspace_links(businessId INTEGER PRIMARY KEY,baseUrl TEXT,workspaceId TEXT,apiKeyEncrypted TEXT,mode TEXT);
    ''')
    for business in (1, 2):
        conn.execute('INSERT INTO instances VALUES(?,1)', (business,))
        conn.execute("INSERT INTO onyx_tenant_links VALUES(?,?,?,'STAGING','ENV_REF')", (business, module.ALIASES[0][3], business))
        conn.execute('INSERT INTO onyx_agent_bindings VALUES(?,?,?)', (business, module.ALIASES[1][3], business * 10))
        conn.execute('INSERT INTO onyx_mcp_tool_bindings VALUES(?,?,?)', (business, module.ALIASES[2][3], business * 100))
        conn.execute("INSERT INTO twenty_workspace_links VALUES(?,?,?,'opaque-ciphertext','live')", (business, module.ALIASES[3][3], str(business)))
    conn.commit()
    yield conn
    conn.close()


def snapshot(db):
    return {table: db.execute(f'SELECT * FROM {table} ORDER BY {scope}').fetchall()
            for table, scope, *_ in module.ALIASES}


def test_preview_does_not_write(db):
    before = snapshot(db)
    assert module.migrate(db, 1, 1, '1')['applied'] is False
    assert snapshot(db) == before


def test_only_urls_change_in_selected_business_and_retry_is_noop(db):
    before = snapshot(db)
    result = module.migrate(db, 1, 1, '1', apply=True)
    assert sum(result['changed_rows'].values()) == 4
    after = snapshot(db)
    for table, _, _, _, new in module.ALIASES:
        assert after[table][1] == before[table][1]
        assert after[table][0] == (before[table][0][0], new, *before[table][0][2:])
    assert sum(module.migrate(db, 1, 1, '1', apply=True)['changed_rows'].values()) == 0


@pytest.mark.parametrize('business,pair,workspace', [(1, 2, '1'), (1, 1, '2'), (99, 1, '1')])
def test_wrong_business_or_backend_identity_is_rejected(db, business, pair, workspace):
    before = snapshot(db)
    with pytest.raises(ValueError):
        module.migrate(db, business, pair, workspace, apply=True)
    assert snapshot(db) == before


def test_partial_changes_roll_back_when_any_binding_differs(db):
    db.execute("UPDATE twenty_workspace_links SET baseUrl='https://another-server.invalid' WHERE businessId=1")
    db.commit()
    before = snapshot(db)
    with pytest.raises(ValueError):
        module.migrate(db, 1, 1, '1', apply=True)
    assert snapshot(db) == before
