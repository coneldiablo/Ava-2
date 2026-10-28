#!/usr/bin/env python3
"""
CLI Runner for AVA ↔ Onyx Knowledge Base Migration (Stage 4)
Supports Dry Run reports and live outbox enqueueing.

Usage:
  python3 scripts/run_onyx_knowledge_migration.py --business-id 1 --dry-run
  python3 scripts/run_onyx_knowledge_migration.py --business-id 1
"""

import os
import sys
import json
import argparse

# Ensure repo root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.core.onyx_migration_runner import OnyxKnowledgeMigrator


def main():
    parser = argparse.ArgumentParser(description="AVA -> Onyx Knowledge Migration Tool (Stage 4)")
    parser.add_argument("--business-id", type=int, default=1, help="AVA business_id / instanceId (default: 1)")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Run simulation only without writing to outbox")
    parser.add_argument("--db-path", type=str, default=None, help="Custom SQLite DB path")
    parser.add_argument("--json", action="store_true", default=False, help="Output raw JSON instead of table")

    args = parser.parse_args()

    migrator = OnyxKnowledgeMigrator(db_path=args.db_path)
    report = migrator.run_migration(business_id=args.business_id, dry_run=args.dry_run)

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(migrator.format_cli_report(report))

    if report["status"] == "FAIL":
        sys.exit(1)


if __name__ == "__main__":
    main()
