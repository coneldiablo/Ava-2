"""Shared, read-only knowledge route for real voice and WhatsApp traffic."""
from __future__ import annotations

import asyncio
import time
from typing import Literal

from src.core.onyx_agent_runner import OnyxAgentRunner, current_knowledge_sources
from src.core.onyx_client import OnyxClientError
from src.core.onyx_db import get_db_connection
from src.core.onyx_native_runtime_config import native_runtime_config, native_runtime_scope


class OnyxKnowledgeRuntime:
    def __init__(self, db_path=None, *, runner_factory=OnyxAgentRunner,
                 native_runtime_config_provider=native_runtime_config):
        self.db_path = db_path
        self.runner_factory = runner_factory
        self.native_runtime_config_provider = native_runtime_config_provider

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
        timings = {'guard_ms': 0, 'runner_ms': None, 'total_ms': 0, 'queue_ms': None,
                   'retrieval_ms': None, 'model_ttft_ms': None,
                   'measurement': 'nonstreaming_http_lifecycle'}

        def respond(**fields):
            timings['total_ms'] = round((time.monotonic()-started)*1000, 3)
            return {**envelope, **fields, 'response_time_ms': round(timings['total_ms']),
                    'timings': dict(timings)}

        allowed = {'ACTIVE_LIVE'} | ({'STAGING', 'ACTIVE'} if preview else set())
        # No operational tools, model-supplied scope, raw CRM history or PMS
        # mutations enter this route. PMS intents retain their separate firewall.
        # Preview is a document question, not a live WhatsApp turn. Give the
        # index/generation its own bounded window; the HTTP caller must also
        # allow time for stop-chat and private-session cleanup after a timeout.
        budget = 30 if preview else (8 if channel == 'voice' else 25)
        try:
            guard_started = time.monotonic()
            native_scope = native_runtime_scope(self.db_path, business_id, self.native_runtime_config_provider)
            state = self._state(business_id) if native_scope is None else 'NATIVE_LIVE'
            if native_scope is None and state not in allowed:
                return respond(error_code='ONYX_RUNTIME_NOT_LIVE', tenant_status=state)
            if not self._customer_available(business_id, customer_id):
                return respond(error_code='ONYX_RUNTIME_CUSTOMER_UNAVAILABLE')
            corpus_state, initial_sources = current_knowledge_sources(self.db_path, business_id, native_scope=native_scope)
            timings['guard_ms'] = round((time.monotonic()-guard_started)*1000, 3)
            if corpus_state != 'READY':
                return respond(error_code=f'ONYX_RUNTIME_{corpus_state}')
            native_options = ({'native_runtime_config_provider': self.native_runtime_config_provider}
                              if native_scope is not None else {})
            runner = self.runner_factory(db_path=self.db_path, timeout_seconds=budget, **native_options)
            context_args = {'customer_id': customer_id} if customer_id is not None else {}
            runner_started = time.monotonic()
            try:
                result = await asyncio.wait_for(runner.answer_query_async(
                    business_id=business_id, query=question, agent_role='sales', **context_args), timeout=budget)
            finally:
                # Includes actual stop/private-session cleanup on timeout.
                timings['runner_ms'] = round((time.monotonic()-runner_started)*1000, 3)
            # Rollback/disable must also win over an already running request.
            current_native = native_runtime_scope(self.db_path, business_id, self.native_runtime_config_provider)
            if (current_native != native_scope
                    or (native_scope is None and self._state(business_id) not in allowed)):
                return respond(error_code='ONYX_RUNTIME_DISABLED_DURING_REQUEST')
            if not self._customer_available(business_id, customer_id):
                return respond(error_code='ONYX_RUNTIME_CUSTOMER_UNAVAILABLE')
            if result.get('business_id') != business_id:
                return respond(error_code='ONYX_RUNTIME_SCOPE_MISMATCH')
            if customer_id is not None and (result.get('customer_id') != customer_id
                    or result.get('customer_context_provided') is not True):
                return respond(error_code='ONYX_RUNTIME_CUSTOMER_MISMATCH')
            if result.get('grounded') is not True or not result.get('citations'):
                return respond(error_code='ONYX_RUNTIME_UNGROUNDED')
            corpus_state, sources = current_knowledge_sources(self.db_path, business_id, native_scope=native_scope)
            if corpus_state != 'READY':
                return respond(error_code=f'ONYX_RUNTIME_{corpus_state}')
            for citation in result['citations']:
                if (not isinstance(citation, dict) or type(citation.get('source_id')) is not int
                        or citation['source_id'] not in sources
                        or (citation.get('external_id') is not None
                            and citation['external_id'] != sources[citation['source_id']]['external_id'])):
                    return respond(error_code='ONYX_RUNTIME_SCOPE_MISMATCH')
                if (citation['source_id'] not in initial_sources
                        or sources[citation['source_id']]['content_hash']
                            != initial_sources[citation['source_id']]['content_hash']):
                    return respond(error_code='ONYX_RUNTIME_INDEXING')
            timings['runner'] = result.get('timings')
            return respond(handled=True, answer=result['answer'], spoken=result['answer'],
                    citations=result['citations'], grounded=True,
                    grounding_verification=result['grounding_verification'],
                    customer_context_provided=result.get('customer_context_provided') is True,
                    source_timestamp=result['timestamp'], stale=False,
                    should_handoff=False, requires_manager=False, missing_info=[])
        except asyncio.TimeoutError:
            return respond(error_code='ONYX_RUNTIME_TIMEOUT')
        except OnyxClientError as error:
            # Only fixed, server-owned codes cross the API boundary. Never
            # expose upstream text, request bodies, credentials or query text.
            code = {'ONYX_RUNTIME_EMPTY': 'ONYX_RUNTIME_EMPTY',
                    'ONYX_RUNTIME_INDEXING': 'ONYX_RUNTIME_INDEXING',
                    'ONYX_CROSS_TENANT_SOURCE': 'ONYX_RUNTIME_SCOPE_MISMATCH',
                    'ONYX_UNVERIFIED_CITATION': 'ONYX_RUNTIME_SCOPE_MISMATCH',
                    'ONYX_STALE_SOURCE': 'ONYX_RUNTIME_INDEXING',
                    'ONYX_NATIVE_RUNTIME_TIMEOUT': 'ONYX_RUNTIME_TIMEOUT',
                    'ONYX_NATIVE_RUNTIME_CONFIG_INVALID': 'ONYX_NATIVE_RUNTIME_CONFIG_INVALID',
                    'ONYX_NATIVE_RUNTIME_NOT_READY': 'ONYX_NATIVE_RUNTIME_NOT_READY'}.get(error.code, 'ONYX_RUNTIME_UNAVAILABLE')
            return respond(error_code=code)
        except Exception:
            # Provider messages may contain credentials or guest information.
            return respond(error_code='ONYX_RUNTIME_UNAVAILABLE')
