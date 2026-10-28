"""Shared, read-only knowledge route for real voice and WhatsApp traffic."""
from __future__ import annotations

import asyncio
import time
from typing import Literal

from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_db import get_db_connection


class OnyxKnowledgeRuntime:
    def __init__(self, db_path=None, *, runner_factory=OnyxAgentRunner):
        self.db_path = db_path
        self.runner_factory = runner_factory

    def _state(self, business_id):
        with get_db_connection(self.db_path) as conn:
            business = conn.execute('SELECT id FROM instances WHERE id=? AND isActive=1', (business_id,)).fetchone()
            if not business:
                return 'BUSINESS_UNAVAILABLE'
            exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onyx_tenant_links'").fetchone()
            if not exists:
                return 'UNLINKED'
            row = conn.execute('SELECT status FROM onyx_tenant_links WHERE business_id=?', (business_id,)).fetchone()
            return row['status'] if row else 'UNLINKED'

    def _customer_available(self, business_id, customer_id):
        if customer_id is None:
            return True
        if type(customer_id) is not int or customer_id < 1:
            return False
        with get_db_connection(self.db_path) as conn:
            row = conn.execute('SELECT chatId FROM clients WHERE id=? AND instanceId=?',
                               (customer_id, business_id)).fetchone()
            return bool(row and not str(row['chatId']).endswith(('@g.us', '@broadcast')))

    async def answer(self, *, business_id: int, question: str,
                     channel: Literal['voice', 'whatsapp'], correlation_id: str, preview=False,
                     customer_id: int | None = None):
        started = time.monotonic()
        envelope = {'business_id': business_id, 'channel': channel, 'correlation_id': correlation_id,
                    'provider': 'onyx', 'handled': False, 'preview': preview,
                    'read_only': True, 'manager_task_created': False, 'customer_id': customer_id}
        state = self._state(business_id)
        allowed = {'ACTIVE_LIVE'} | ({'STAGING', 'ACTIVE'} if preview else set())
        if state not in allowed:
            return {**envelope, 'error_code': 'ONYX_RUNTIME_NOT_LIVE', 'tenant_status': state}
        if not self._customer_available(business_id, customer_id):
            return {**envelope, 'error_code': 'ONYX_RUNTIME_CUSTOMER_UNAVAILABLE'}
        # No operational tools, model-supplied scope, raw CRM history or PMS
        # mutations enter this route. PMS intents retain their separate firewall.
        # Document Q&A is an interactive web check, not a voice turn. Live
        # retrieval and generation can exceed the 25-second messaging budget;
        # keep voice and real WhatsApp latency limits unchanged.
        budget = 60 if preview else (8 if channel == 'voice' else 25)
        try:
            runner = self.runner_factory(db_path=self.db_path, timeout_seconds=budget)
            context_args = {'customer_id': customer_id} if customer_id is not None else {}
            result = await asyncio.wait_for(runner.answer_query_async(
                business_id=business_id, query=question, agent_role='sales', **context_args), timeout=budget)
            # Rollback/disable must also win over an already running request.
            if self._state(business_id) not in allowed:
                return {**envelope, 'error_code': 'ONYX_RUNTIME_DISABLED_DURING_REQUEST'}
            if not self._customer_available(business_id, customer_id):
                return {**envelope, 'error_code': 'ONYX_RUNTIME_CUSTOMER_UNAVAILABLE'}
            if result.get('business_id') != business_id:
                return {**envelope, 'error_code': 'ONYX_RUNTIME_SCOPE_MISMATCH'}
            if customer_id is not None and (result.get('customer_id') != customer_id
                    or result.get('customer_context_provided') is not True):
                return {**envelope, 'error_code': 'ONYX_RUNTIME_CUSTOMER_MISMATCH'}
            if result.get('grounded') is not True or not result.get('citations'):
                return {**envelope, 'error_code': 'ONYX_RUNTIME_UNGROUNDED'}
            return {**envelope, 'handled': True, 'answer': result['answer'], 'spoken': result['answer'],
                    'citations': result['citations'], 'grounded': True,
                    'grounding_verification': result['grounding_verification'],
                    'customer_context_provided': result.get('customer_context_provided') is True,
                    'source_timestamp': result['timestamp'], 'stale': False,
                    'should_handoff': False, 'requires_manager': False, 'missing_info': [],
                    'response_time_ms': round((time.monotonic()-started)*1000)}
        except asyncio.TimeoutError:
            return {**envelope, 'error_code': 'ONYX_RUNTIME_TIMEOUT'}
        except Exception:
            # Provider messages may contain credentials or guest information.
            return {**envelope, 'error_code': 'ONYX_RUNTIME_UNAVAILABLE'}
