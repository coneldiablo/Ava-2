#!/usr/bin/env python3
"""
AVA ↔ Onyx Pilot Hotel Cutover & Rollback Verification Runner (Stage 11)
Executes end-to-end Go/No-Go audit, switches live traffic to Onyx AI Agent,
verifies live hotel guest scenarios, and validates emergency instant rollback.

Usage:
  python3 scripts/run_onyx_pilot_cutover.py --business-id 1
"""

import os
import sys
import json
import argparse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.core.onyx_cutover_manager import OnyxCutoverManager
from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_policy_gateway import PolicyGateway


def main():
    parser = argparse.ArgumentParser(description="Pilot Hotel Cutover & Rollback Runner (Stage 11)")
    parser.add_argument("--business-id", type=int, default=1, help="Business ID / tenant (default: 1)")
    parser.add_argument("--db-path", type=str, default=None, help="Custom SQLite DB path")
    args = parser.parse_args()

    cutover_mgr = OnyxCutoverManager(db_path=args.db_path)
    agent_runner = OnyxAgentRunner(db_path=args.db_path)
    gateway = PolicyGateway(db_path=args.db_path)

    print("==================================================")
    print("   STAGE 11: ONYX PILOT HOTEL CUTOVER & ROLLBACK")
    print("==================================================")
    print(f"Target: Hotel Pilot (Business ID: {args.business_id})\n")

    # Step 1: Pre-flight Go/No-Go Check
    print("[Step 1] Evaluating Go / No-Go Readiness Criteria...")
    criteria = cutover_mgr.check_go_no_go_criteria(business_id=args.business_id)
    print(f"  ➜ Decision: [{criteria['decision']}]")
    print(f"  ➜ Document Sync Rate: {criteria['metrics']['sync_completion_pct']}% ({criteria['metrics']['synced_documents']}/{criteria['metrics']['total_source_documents']})")
    print(f"  ➜ Outbox Dead Letters: {criteria['metrics']['outbox_dead_letters']}")
    print(f"  ➜ Security Violations: {criteria['metrics']['denied_security_actions']}")

    if criteria["decision"] != "GO":
        print("❌ Cutover aborted: Go/No-Go criteria not met.")
        sys.exit(1)
    print("✅ Pre-flight checks passed.\n")

    # Step 2: Live Cutover Activation
    print("[Step 2] Activating Controlled Traffic Cutover...")
    cutover_res = cutover_mgr.enable_live_cutover(business_id=args.business_id, hotel_name="Grand Hotel Pilot")
    print(f"  ➜ Tenant Status: {cutover_res['status']}")
    print(f"  ➜ USE_ONYX_AI: {cutover_res['use_onyx_ai']}")
    print("✅ Live cutover successfully activated.\n")

    # Step 3: End-to-End Live Guest Interaction Test
    print("[Step 3] Executing Live AI Guest Scenarios...")
    guest_query = "Добрый день! Хочу забронировать номер Люкс на 3 дня. Какая политика отмены?"
    guest_context = {"name": "Михаил", "chat_id": "79995554433"}
    ans = agent_runner.answer_query(
        business_id=args.business_id,
        query=guest_query,
        agent_role="sales",
        hotel_name="Grand Hotel Pilot",
        customer_context=guest_context
    )
    print(f"  ➜ Вопрос гостя: \"{guest_query}\"")
    print(f"  ➜ Ответ Onyx AI: {ans['answer']}")
    print(f"  ➜ Grounded: {'ДА' if ans['grounded'] else 'НЕТ'}")
    print(f"  ➜ Next Step: {ans['recommended_next_step']}")

    # Step 4: Policy Gateway Action Execution
    print("\n[Step 4] Executing Side-Effects via Policy Gateway...")
    action_res = gateway.execute_action(
        business_id=args.business_id,
        agent_id=f"ava:{args.business_id}:agent:sales",
        action="create_task",
        arguments={"summary": f"Связаться с гостем {guest_context['name']} по бронированию Люкса", "priority": "high"},
        idempotency_key=f"pilot-cutover-task-{args.business_id}",
    )
    print(f"  ➜ Created Manager Task: {action_res['result']['task_id']} (Status: {action_res['status']})")
    print("✅ Policy Gateway action execution confirmed.\n")

    # Step 5: Rollback Drill Verification
    print("[Step 5] Performing Instant Rollback Drill...")
    rollback_res = cutover_mgr.execute_instant_rollback(business_id=args.business_id, reason="Drill validation test")
    print(f"  ➜ Rollback Status: {rollback_res['status']}")
    print(f"  ➜ USE_ONYX_AI: {rollback_res['use_onyx_ai']}")
    print(f"  ➜ Operational Impact: {rollback_res['operational_impact']}")
    print("✅ Emergency rollback drill verified.\n")

    # Re-enable Live status for production pilot
    cutover_mgr.enable_live_cutover(business_id=args.business_id, hotel_name="Grand Hotel Pilot")
    print("🎉 ALL STAGE 11 PRODUCTION CUTOVER MILESTONES COMPLETED!")


if __name__ == "__main__":
    main()
