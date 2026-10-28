#!/usr/bin/env python3
"""
AVA ↔ Onyx Security & Shadow Mode Verification Suite (Stage 10)
Tests Prompt Injection, Cross-Tenant Isolation, Action Forgery, Replay Attacks,
Circuit Breaker Resilience, and Shadow Mode Rollout Criteria.

Usage:
  python3 scripts/run_onyx_security_and_shadow_test.py --business-id 1
"""

import os
import sys
import json
import time
import argparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.core.onyx_policy_gateway import PolicyGateway, PolicyGatewayError
from src.core.onyx_resilience import OnyxCircuitBreaker, CircuitState
from src.core.onyx_shadow_mode import OnyxShadowModeRunner
from src.core.onyx_agent_runner import OnyxAgentRunner

SHADOW_QUERIES = [
    "Какие категории номеров есть в отеле?", "Какое время заезда и выезда?",
    "Сколько стоит завтрак?", "Есть ли трансфер в аэропорт?",
    "Разрешено ли проживание с собакой?", "Условия для ребенка 4 лет?",
    "Каковы условия отмены?", "Работает ли бассейн?", "Есть ли парковка?", "Есть ли Wi-Fi в номерах?",
]


def run_security_suite(business_id: int, db_path: str = None) -> bool:
    print("==================================================")
    print("   STAGE 10: ONYX SECURITY & RESILIENCE TESTS")
    print("==================================================")
    all_passed = True
    gw = PolicyGateway(db_path=db_path)

    # Untrusted instructions are data; tenant/control fields are not arguments.
    print("[1/5] Testing Tenant Parameter Injection Protection...")
    try:
        gw.execute_action(
            business_id=business_id,
            agent_id=f"ava:{business_id}:agent:sales",
            action="create_task",
            arguments={"summary": "Scope injection test", "priority": "high", "business_id": business_id + 100},
            idempotency_key="security-scope-injection",
        )
        print("  ❌ FAIL: Malicious injection was not blocked!")
        all_passed = False
    except PolicyGatewayError as e:
        if e.code == "INVALID_SCHEMA":
            print("  ✅ PASS: Unexpected tenant parameter rejected (INVALID_SCHEMA)")
        else:
            print(f"  ❌ FAIL: Unexpected error code: {e.code}")
            all_passed = False

    # 2. Cross-Tenant Action Forgery
    print("\n[2/5] Testing Cross-Tenant Action Forgery...")
    try:
        gw.execute_action(
            business_id=business_id,
            agent_id=f"ava:{business_id + 100}:agent:sales",
            action="update_customer",
            arguments={"customer_id": 1, "lead_status": "hacked"}
        )
        print("  ❌ FAIL: Cross-tenant action was permitted!")
        all_passed = False
    except PolicyGatewayError as e:
        if e.code == "CROSS_TENANT_FORBIDDEN":
            print("  ✅ PASS: Cross-tenant action rejected (CROSS_TENANT_FORBIDDEN)")
        else:
            print(f"  ❌ FAIL: Unexpected error code: {e.code}")
            all_passed = False

    # 3. Replay & Duplicate Action Protection (Idempotency)
    print("\n[3/5] Testing Replay & Duplicate Attack (Idempotency)...")
    idemp_key = f"sec_test_idemp_{int(time.time())}"
    res1 = gw.execute_action(
        business_id=business_id,
        agent_id=f"ava:{business_id}:agent:sales",
        action="create_task",
        arguments={"summary": "Idempotency test task", "priority": "low"},
        idempotency_key=idemp_key
    )
    res2 = gw.execute_action(
        business_id=business_id,
        agent_id=f"ava:{business_id}:agent:sales",
        action="create_task",
        arguments={"summary": "Idempotency test task", "priority": "low"},
        idempotency_key=idemp_key
    )
    if res1["status"] == "EXECUTED" and res2["status"] == "EXECUTED (CACHED)":
        print("  ✅ PASS: Replay attack intercepted; cached result returned without duplicate execution")
    else:
        print(f"  ❌ FAIL: Idempotency failed: res1={res1['status']}, res2={res2['status']}")
        all_passed = False

    # 4. Resilience & Circuit Breaker Failover
    print("\n[4/5] Testing Circuit Breaker & Failover Under Outage...")
    cb = OnyxCircuitBreaker(failure_threshold=2, recovery_timeout=0.1, request_timeout=1.0)
    
    # Simulate 2 consecutive network failures
    cb.record_failure(ConnectionError("Simulated Onyx backend network failure 1"))
    cb.record_failure(ConnectionError("Simulated Onyx backend network failure 2"))

    assert cb.state == CircuitState.OPEN
    print("  ✅ Circuit breaker successfully tripped to OPEN state after consecutive failures")

    # Verify fail-fast when OPEN
    assert cb.can_execute() is False
    print("  ✅ Circuit breaker fast-failed (can_execute=False) without network penalty")

    # 5. Shadow Mode Evaluation
    print("\n[5/5] Executing Shadow Mode Comparison (10 Queries)...")
    shadow_runner = OnyxShadowModeRunner(db_path=db_path)
    results = []
    for q in SHADOW_QUERIES:
        res = shadow_runner.process_shadow_query(
            business_id=business_id,
            query=q,
            legacy_response='',  # A fabricated legacy answer is not a quality oracle.
        )
        results.append(res)

    eval_report = shadow_runner.evaluate_shadow_metrics(results)
    m = eval_report["metrics"]

    print("--------------------------------------------------")
    print("   SHADOW MODE ROLLOUT CRITERIA REPORT")
    print("--------------------------------------------------")
    print(f"Total Queries Evaluated:    {eval_report['total_queries_evaluated']}")
    print(f"RAG Accuracy:               {m['rag_accuracy_pct']}% (Target: >= 90%)")
    print(f"Grounded Answers:           {m['grounded_answers_pct']}% (Target: >= 90%)")
    print(f"Critical Action Accuracy:   {m['critical_action_accuracy_pct']}% (Target: 100%)")
    print(f"Cross-Tenant Incidents:     {m['cross_tenant_incidents']} (Target: 0)")
    print(f"Average Latency:            {m['avg_latency_ms']} ms")
    print(f"Sync Lag:                   {m['sync_lag_sec']} s (Target: < 300s)")
    print(f"Rollout Status:             [{eval_report['rollout_status']}]")
    print("Quality/security/action accuracy stay unknown until separate operator evidence is reviewed.")
    print("Ten smoke queries do not replace 24-hour shadow observation or a live voice/WhatsApp test.")
    print("--------------------------------------------------")

    if eval_report["rollout_status"] == "READY_FOR_PILOT" and all_passed:
        print("\n🎉 ALL STAGE 10 SECURITY & SHADOW CRITERIA PASSED!")
        return True
    else:
        print("\n❌ Gaps detected in rollout evaluation.")
        return False


def main():
    parser = argparse.ArgumentParser(description="Onyx Security & Shadow Mode Suite (Stage 10)")
    parser.add_argument("--business-id", type=int, default=1, help="Business ID / tenant (default: 1)")
    parser.add_argument("--db-path", type=str, default=None, help="Custom SQLite DB path")
    args = parser.parse_args()

    ok = run_security_suite(business_id=args.business_id, db_path=args.db_path)
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
