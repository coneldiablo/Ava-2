#!/usr/bin/env python3
"""Real Onyx check with a synthetic guest in an isolated SQLite database.

Does not create a CRM guest, send a message, change PMS, enable cutover or modify
production profiles. Reuses the selected hotel's existing private knowledge
binding. Onyx receives only public hotel facts and the artificial preference.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time

from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_db import get_db_connection, init_onyx_tables


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--business-id', required=True, type=int)
    parser.add_argument('--candidate-runner', type=Path)
    args = parser.parse_args()
    if args.business_id < 1:
        raise ValueError('Positive business ID required')
    runner_class = OnyxAgentRunner
    if args.candidate_runner:
        spec = importlib.util.spec_from_file_location('ava_context_candidate', args.candidate_runner)
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        runner_class = candidate.OnyxAgentRunner
    with tempfile.TemporaryDirectory(prefix='ava-context-qa-') as directory:
        path = str(Path(directory) / 'qa.sqlite')
        with get_db_connection() as live, sqlite3.connect(path) as qa:
            qa.executescript('''
                CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,isActive INTEGER,businessType TEXT,hotelTimezone TEXT);
                CREATE TABLE knowledge_base(id INTEGER PRIMARY KEY,instanceId INTEGER,isCurrent INTEGER,contentHash TEXT);
                CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,senderName TEXT,leadStatus TEXT);
                CREATE TABLE client_profiles(instanceId INTEGER,chatId TEXT,needs TEXT);
            ''')
            business = live.execute('SELECT id,name,isActive,businessType,hotelTimezone FROM instances WHERE id=? AND isActive=1',
                                    (args.business_id,)).fetchone()
            if not business:
                raise ValueError('Active business not found')
            qa.execute('INSERT INTO instances VALUES(?,?,?,?,?)', tuple(business))
            init_onyx_tables(qa)
            for table in ('onyx_tenant_links', 'onyx_agent_bindings', 'onyx_document_links'):
                for row in live.execute(f'SELECT * FROM {table} WHERE business_id=?', (args.business_id,)):
                    qa.execute(f'INSERT INTO {table} ({",".join(row.keys())}) VALUES ({",".join("?" for _ in row)})', tuple(row))
            for row in live.execute('SELECT id,instanceId,isCurrent,contentHash FROM knowledge_base WHERE instanceId=?', (args.business_id,)):
                qa.execute('INSERT INTO knowledge_base VALUES(?,?,?,?)', tuple(row))
            qa.execute("INSERT INTO clients VALUES(999001,?,'ava-context-qa@lid','Контрольный гость AVA','qualified')", (args.business_id,))
            qa.execute("INSERT INTO client_profiles VALUES(?,'ava-context-qa@lid','Контрольное пожелание: тихий номер с видом на сад.')", (args.business_id,))
        started = time.monotonic()
        result = await runner_class(db_path=path, timeout_seconds=60).answer_query_async(
            business_id=args.business_id, customer_id=999001,
            query='Во сколько заезд в отель и какое пожелание к номеру я уже оставлял? Назови только время заезда и моё пожелание.')
        summary = {key: result.get(key) for key in ('business_id', 'customer_id', 'customer_context_provided', 'grounded', 'citations', 'answer')}
        summary.update(duration_ms=round((time.monotonic()-started)*1000), synthetic_guest=True,
                       production_crm_changed=False, live_cutover=False)
        print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        print(json.dumps({'error_code': getattr(error, 'code', type(error).__name__),
                          'status_code': getattr(error, 'status_code', None)}))
        raise SystemExit(1)
