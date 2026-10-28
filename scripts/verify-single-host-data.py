#!/usr/bin/env python3
"""Read-only migration evidence. Never print credentials or guest content."""
import argparse
import json
import sqlite3
from pathlib import Path


def connect(path):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    return connection


def rows(connection, sql):
    return [dict(row) for row in connection.execute(sql)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/root/ava-current"))
    parser.add_argument("--snapshot", required=True, type=Path)
    args = parser.parse_args()
    result = {"databases": {}, "old_host_references": []}
    for name in ("data/call_history.db", "data/whatsapp_crm/crm_v2.db"):
        with connect(args.root / name) as live, connect(args.snapshot / name) as before:
            tables = [r[0] for r in before.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )]
            counts = {}
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                try:
                    old = before.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
                    new = live.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
                except sqlite3.OperationalError as error:
                    if str(error) != "no such module: vec0":
                        raise
                    counts[table] = {"row_count": "not checked: vec0 extension unavailable in system Python"}
                    continue
                if old or new:
                    counts[table] = {"snapshot": old, "live": new}
            result["databases"][name] = {"quick_check": "ok", "counts": counts}
            if name.endswith("crm_v2.db"):
                # Status/timestamps may change on startup. Compare all remaining
                # business settings, including credentials, without exposing them.
                columns = [r[1] for r in before.execute("PRAGMA table_info(instances)")
                           if r[1] not in {"updatedAt", "openWaStatus"}]
                select = ','.join('"' + c + '"' for c in columns)
                query = f"SELECT {select} FROM instances ORDER BY id"
                old_settings, new_settings = rows(before, query), rows(live, query)
                result["business_settings_preserved"] = old_settings == new_settings
                assert result["business_settings_preserved"], "Business settings changed during migration"
                result["businesses"] = rows(live, "SELECT id,name,businessType,voiceAiProvider,voiceName,voiceContextName FROM instances ORDER BY id")
                result["pms"] = rows(live, "SELECT businessId,provider,enabled,mode,externalHotelId,connectionStatus,pollingStatus,webhookStatus,lastSyncAt,lastSuccessfulAvailabilityAt,lastErrorCode FROM pms_integrations")
                result["twenty"] = rows(live, "SELECT businessId,enabled,mode,connectionStatus,lastErrorCode FROM twenty_workspace_links")
                result["onyx"] = rows(live, "SELECT business_id,status,onyx_version FROM onyx_tenant_links")
                result["memory_jobs"] = rows(live, "SELECT state,lastErrorCode,COUNT(*) AS count FROM crm_memory_jobs GROUP BY state,lastErrorCode")
                for table in ("instances", "twenty_workspace_links", "onyx_tenant_links"):
                    for record in rows(live, f"SELECT * FROM {table}"):
                        for key, value in record.items():
                            if isinstance(value, str) and "83.136.235.18" in value:
                                result["old_host_references"].append({"table": table, "field": key})
    env = args.root / ".env"
    for line in env.read_text().splitlines():
        if not line.lstrip().startswith("#") and "=" in line and "83.136.235.18" in line:
            result["old_host_references"].append({"file": ".env", "field": line.split("=", 1)[0]})
    for folder in (args.root / "config", Path("/etc/nginx/sites-enabled"), Path("/etc/asterisk")):
        for path in folder.rglob("*"):
            if folder == Path("/etc/asterisk") and path.suffix != ".conf":
                continue  # Historical .bak files are not active configuration.
            if path.is_file() and path.stat().st_size < 2_000_000:
                for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
                    if "83.136.235.18" in line and not line.lstrip().startswith(("#", ";")):
                        result["old_host_references"].append({"file": str(path), "line": number})
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
