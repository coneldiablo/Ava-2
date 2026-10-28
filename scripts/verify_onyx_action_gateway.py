#!/usr/bin/env python3
"""Read-only gateway check; optional clearly labelled CRM task (never a call/send).

Run inside admin_ui so service authentication and the shared CRM DB are real.
The optional task is deliberately retained for audit, not silently deleted.
"""
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.core.onyx_policy_gateway import PolicyGateway, PolicyGatewayError


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--business-id', required=True, type=int)
    parser.add_argument('--write-test-task', action='store_true')
    parser.add_argument('--idempotency-key')
    args = parser.parse_args()
    if args.business_id < 1 or (args.write_test_task and not args.idempotency_key):
        parser.error('Positive business and explicit idempotency key required for write test')
    gateway = PolicyGateway()
    common = {'business_id': args.business_id, 'agent_id': f'ava:{args.business_id}:agent:sales'}
    result = gateway.execute_action(**common, action='get_hotel_info', arguments={})
    assert result['result']['hotel']['id'] == args.business_id
    receipt = {'business_id': args.business_id, 'hotel_read': 'passed', 'calls_placed': 0, 'messages_sent': 0}
    try:
        gateway.execute_action(args.business_id, f'ava:{args.business_id + 1}:agent:sales', 'get_hotel_info', {})
    except PolicyGatewayError as error:
        assert error.code == 'CROSS_TENANT_FORBIDDEN'
        receipt['cross_tenant_guard'] = 'passed'
    else:
        raise AssertionError('Cross-tenant request was not blocked')
    if args.write_test_task:
        action = {'action': 'create_task', 'arguments': {
            'summary': '[ТЕСТ РАЗВЁРТЫВАНИЯ ONYX] Проверка записи и защиты от дублей. Клиенту не звонить и не писать.',
            'priority': 'low'}, 'idempotency_key': args.idempotency_key}
        first = gateway.execute_action(**common, **action)
        repeated = PolicyGateway().execute_action(**common, **action)
        assert repeated['status'] == 'EXECUTED (CACHED)' and first['result'] == repeated['result']
        task_id = first['result']['task_id']
        with sqlite3.connect(os.environ['DB_PATH']) as conn:
            count = conn.execute('SELECT COUNT(*) FROM manager_tasks WHERE taskId=? AND instanceId=?', (task_id, args.business_id)).fetchone()[0]
        assert count == 1
        receipt.update(task_id=task_id, task_count=count, durable_replay='passed')
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
