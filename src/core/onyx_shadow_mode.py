"""Onyx shadow observations. Citations are evidence of scope, not accuracy.

No guest-facing actions execute here. Semantic quality and action/security
acceptance require separately recorded operator evidence; absent means unknown.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from datetime import datetime, timezone
from typing import Any

from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_client import OnyxClientError
from src.core.onyx_db import get_db_connection, init_onyx_tables


def observation_hash(result: dict) -> str:
    """Bind review to the exact tenant, question, answer and cited sources."""
    payload = {key: result.get(key) for key in (
        'business_id', 'query', 'onyx_response', 'citations', 'timestamp', 'execution_source', 'error_code',
    )}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError):
        return None


class OnyxShadowModeRunner:
    def __init__(self, db_path: str | None = None, *, agent_runner=None):
        self.db_path = db_path
        self.agent_runner = agent_runner or OnyxAgentRunner(db_path=db_path)
        with get_db_connection(db_path) as conn:
            init_onyx_tables(conn)

    def process_shadow_query(self, business_id: int, query: str, legacy_response: str,
                             expected_intent: str | None = None, customer_context: dict | None = None,
                             hotel_name: str = '') -> dict:
        start = time.monotonic()
        error_code = None
        try:
            response = self.agent_runner.answer_query(
                business_id=business_id, query=query, agent_role='sales',
                hotel_name=hotel_name, customer_context=customer_context)
        except OnyxClientError as error:
            error_code = error.code
            response = {}
        with get_db_connection(self.db_path) as conn:
            lag = conn.execute('''SELECT
                COALESCE(MAX(0,(julianday('now')-julianday(MIN(created_at)))*86400),0) AS lag
                FROM onyx_sync_outbox WHERE business_id=? AND status IN ('PENDING','RETRY','PROCESSING')''',
                (business_id,)).fetchone()['lag']
        citations = response.get('citations') or []
        result = {
            'business_id': business_id, 'query': query, 'legacy_response': legacy_response,
            'expected_intent': expected_intent, 'onyx_response': response.get('answer'),
            'citations': citations, 'grounded': bool(response.get('grounded') and citations),
            'source_scope_verified': response.get('grounding_verification') == 'scoped_citations_only' and bool(citations),
            'execution_source': response.get('execution_source'), 'error_code': error_code,
            # Neither a citation nor the legacy answer is a semantic oracle.
            'accuracy_score': None, 'critical_action_accuracy': None,
            'cross_tenant_incident': True if error_code == 'ONYX_CROSS_TENANT_SOURCE' else None,
            'review_required': True, 'sync_lag_sec': round(float(lag), 2),
            'latency_ms': round((time.monotonic()-start)*1000, 2),
            'recommended_next_step': response.get('recommended_next_step', 'legacy_fallback'),
            'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        }
        result['observation_hash'] = observation_hash(result)
        return result

    def evaluate_shadow_metrics(self, shadow_results: list[dict], *, acceptance_evidence: dict | None = None,
                                minimum_queries: int = 20, minimum_observation_hours: float = 24) -> dict:
        """Evaluate reviewed observations plus a separate action/security report.

        Review format: reviewer, evidence_reference, observation_hash, accuracy_score
        in [0,1]. Acceptance evidence additionally binds the sorted observation
        hashes and contains actual action/security case counts. These are operator
        attestations, never model-supplied inputs or automatically inferred tests.
        """
        if not shadow_results:
            return {'status': 'NO_DATA', 'metrics': {}, 'rollout_status': 'BLOCKED_GAPS_DETECTED'}
        total = len(shadow_results)
        hashes = [observation_hash(r) for r in shadow_results]
        scores = []
        for result, digest in zip(shadow_results, hashes):
            review = result.get('review') if isinstance(result.get('review'), dict) else {}
            score = review.get('accuracy_score')
            if (isinstance(review, dict) and review.get('reviewer') and review.get('evidence_reference')
                    and review.get('observation_hash') == digest and _number(score) and 0 <= score <= 1):
                scores.append(float(score))
        accuracy = round(sum(scores)/len(scores)*100, 2) if scores else None
        grounded = round(sum(bool(r.get('grounded')) for r in shadow_results)/total*100, 2)
        latencies = sorted(float(r['latency_ms']) for r in shadow_results if _number(r.get('latency_ms')))
        lags = [float(r['sync_lag_sec']) for r in shadow_results if _number(r.get('sync_lag_sec'))]
        times = [_timestamp(r.get('timestamp')) for r in shadow_results]
        valid_times = [t for t in times if t is not None]
        span = (max(valid_times)-min(valid_times)).total_seconds()/3600 if valid_times else 0
        business_ids = {r.get('business_id') for r in shadow_results}
        evidence = acceptance_evidence if isinstance(acceptance_evidence, dict) else {}
        reviewed_at = _timestamp(evidence.get('verified_at'))
        evidence_valid = bool(
            len(business_ids) == 1 and evidence.get('business_id') in business_ids
            and evidence.get('reviewer') and evidence.get('evidence_reference')
            and evidence.get('observation_hashes') == sorted(set(hashes))
            and reviewed_at and valid_times and max(valid_times) <= reviewed_at
            and 0 <= (datetime.now(timezone.utc)-reviewed_at).total_seconds() <= 86400)
        def count(name):
            value = evidence.get(name)
            return value if evidence_valid and type(value) is int and value >= 0 else None
        critical_total, critical_passed = count('critical_action_cases'), count('critical_action_passed')
        security_total, security_incidents = count('security_cases'), count('cross_tenant_incidents')
        critical_accuracy = (round(critical_passed/critical_total*100, 2)
                             if critical_total and critical_passed is not None and critical_passed <= critical_total else None)
        observed_incidents = sum(r.get('cross_tenant_incident') is True for r in shadow_results)
        criteria = {
            'rag_accuracy': len(scores) == total and accuracy is not None and accuracy >= 90,
            'grounded_answers': grounded >= 90,
            'security_isolation': bool(security_total and security_incidents == 0 and observed_incidents == 0),
            'critical_actions': critical_accuracy == 100,
            'sync_lag': len(lags) == total and max(lags) < 300,
            'live_onyx_execution': all(r.get('execution_source') == 'onyx_live' and not r.get('error_code') for r in shadow_results),
            'source_scope': all(r.get('source_scope_verified') is True for r in shadow_results if r.get('grounded')),
            'single_business': len(business_ids) == 1,
            'sample_size': total >= max(20, minimum_queries) and len(set(hashes)) == total,
            'observation_window': len(valid_times) == total and span >= max(24, minimum_observation_hours),
        }
        return {
            'total_queries_evaluated': total, 'reviewed_queries': len(scores),
            'metrics': {
                'rag_accuracy_pct': accuracy, 'grounded_answers_pct': grounded,
                'critical_action_accuracy_pct': critical_accuracy,
                'cross_tenant_incidents': max(observed_incidents, security_incidents) if security_incidents is not None else (observed_incidents or None),
                'security_cases': security_total, 'critical_action_cases': critical_total,
                'avg_latency_ms': round(sum(latencies)/len(latencies), 2) if latencies else None,
                'max_latency_ms': max(latencies) if latencies else None,
                'p95_latency_ms': latencies[math.ceil(len(latencies)*0.95)-1] if latencies else None,
                'sync_lag_sec': max(lags) if lags else None, 'observation_hours': round(span, 2),
            },
            'thresholds': {'rag_accuracy_target': '>= 90%, all observations reviewed',
                           'grounded_target': '>= 90%', 'critical_action_target': '100%, separate evidence required',
                           'cross_tenant_target': '0, separate evidence required', 'sync_lag_target': '< 300s',
                           'minimum_queries': max(20, minimum_queries), 'minimum_observation_hours': max(24, minimum_observation_hours)},
            'rollout_status': 'READY_FOR_PILOT' if all(criteria.values()) else 'BLOCKED_GAPS_DETECTED',
            'rollout_criteria_passed': criteria,
        }
