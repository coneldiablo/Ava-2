#!/usr/bin/env python3
"""
Onyx Sales Agent Smoke Test Runner (Stage 5)
Tests standard hotel customer qualification questions against tenant knowledge base.

Usage:
  python3 scripts/run_onyx_agent_smoke_test.py --business-id 1
"""

import os
import sys
import json
import argparse
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.core.onyx_agent_runner import OnyxAgentRunner

TEST_QUESTIONS = [
    "Какие номера доступны в отеле?",
    "Какая политика отмены бронирования?",
    "Есть ли трансфер из аэропорта и сколько он стоит?",
    "Можно ли заселиться с ребёнком и какие условия?",
    "Можно ли приехать с собакой?",
    "Во сколько начинается завтрак и где он проходит?",
    "Работает ли СПА и бассейн?"
]


def main():
    parser = argparse.ArgumentParser(description="Onyx AI Agent Smoke Test (Stage 5)")
    parser.add_argument("--business-id", type=int, default=1, help="Business ID / tenant (default: 1)")
    parser.add_argument("--db-path", type=str, default=None, help="SQLite database path")
    args = parser.parse_args()

    runner = OnyxAgentRunner(db_path=args.db_path, timeout_seconds=60)

    print("==================================================")
    print("   AVA ➔ ONYX AI SALES AGENT SMOKE TEST")
    print("==================================================")
    print(f"Tenant: hotel_{args.business_id} (Business ID: {args.business_id})\n")

    passed = 0
    total = len(TEST_QUESTIONS)

    for i, q in enumerate(TEST_QUESTIONS, 1):
        print(f"[{i}/{total}] Вопрос: \"{q}\"")
        started = time.monotonic()
        res = runner.answer_query(
            business_id=args.business_id,
            query=q,
            agent_role="sales",
        )

        citation_titles = [c["title"] for c in res["citations"]]
        print(f"  ➜ Ответ: {res['answer']}")
        print(f"  ➜ Источники: {citation_titles}")
        print(f"  ➜ Next Step: {res['recommended_next_step']}")
        print(f"  ➜ Проверенная ссылка на документ: {'ДА' if res['grounded'] else 'НЕТ'}")
        print(f"  ➜ Реальный обработчик: {res['execution_source']}; время: {time.monotonic()-started:.2f} с")
        print("-" * 50)

        if res["grounded"] and len(res["citations"]) > 0:
            passed += 1

    print(f"\nИтог: {passed}/{total} ответов имеют проверенные tenant-scoped цитаты.")
    print("Это connectivity/scope smoke, не оценка точности. Содержание ответов требует сверки с базой знаний.")
    if passed == total:
        print("Результат: SCOPE_SMOKE_PASS; QUALITY_NOT_EVALUATED; LIVE_CUTOVER_NOT_APPROVED")
    else:
        print("Результат: FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
