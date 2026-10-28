#!/usr/bin/env python3
"""Provision bridge secrets from stdin without exposing them in argv or output.

Run on the AVA host after a recovery backup. Input is a JSON object containing
onyx_api_key, twenty_api_key, and twenty_workspace_id. This only configures
Twenty in shadow mode; connection verification and live cutover are separate.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def update_env(path, values):
    lines = path.read_text().splitlines()
    for key, value in values.items():
        # Restrict secret alphabet so dotenv interpolation cannot alter tokens.
        if not re.fullmatch(r"[A-Za-z0-9_./:+~=@%-]+", value):
            raise ValueError(f"Unsupported characters in {key}")
        lines = [line for line in lines if not line.startswith(f"{key}=")]
        lines.append(f"{key}='{value}'")
    stat = path.stat()
    fd, name = tempfile.mkstemp(prefix=".bridge-env-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, stat.st_uid, stat.st_gid)
        with os.fdopen(fd, "w") as stream:
            stream.write("\n".join(lines) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--business-id", type=int, required=True)
    parser.add_argument("--onyx-base-url", required=True)
    parser.add_argument("--twenty-base-url", required=True)
    parser.add_argument("--admin-public-url", required=True)
    parser.add_argument("--crm-public-url", required=True)
    parser.add_argument("--crm-local-url", default="http://127.0.0.1:3011")
    args = parser.parse_args()
    if args.business_id < 1:
        parser.error("business-id must be positive")
    for url in (args.onyx_base_url, args.twenty_base_url, args.admin_public_url, args.crm_public_url):
        if not url.startswith("https://"):
            parser.error("Public bridge URLs must use HTTPS")

    import sys
    credentials = json.load(sys.stdin)
    required = ("onyx_api_key", "twenty_api_key", "twenty_workspace_id")
    if any(not isinstance(credentials.get(key), str) or not credentials[key] for key in required):
        raise ValueError("Required credential is missing")
    env_path = args.root / ".env"
    env = read_env(env_path)
    service_token = env.get("CRM_SERVICE_API_TOKEN")
    if not service_token or not env.get("TWENTY_CREDENTIALS_MASTER_KEY"):
        raise ValueError("AVA service token or Twenty encryption key is missing")

    # Preserve the exact previous env before the atomic update.
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = Path("/root/backups/ava") / f"bridge-config-{timestamp}"
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(env_path, backup / "env.recovery")
    os.chmod(backup / "env.recovery", 0o600)

    body = {
        "base_url": args.twenty_base_url,
        "workspace_id": credentials["twenty_workspace_id"],
        "api_key": credentials["twenty_api_key"],
        "enabled": True,
        "mode": "shadow",
    }
    request = urllib.request.Request(
        f"{args.crm_local_url}/api/ml/hotel-profiles/{args.business_id}/twenty",
        method="PUT", data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {service_token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Do not print a reflected request body or credentials from the API.
        raise RuntimeError(f"Twenty configuration rejected: HTTP {error.code}") from None
    if status != 200 or result.get("success") is False:
        raise RuntimeError("Twenty configuration was not accepted")

    update_env(env_path, {
        f"ONYX_HOTEL_{args.business_id}_API_KEY": credentials["onyx_api_key"],
        "ONYX_SYNC_ENABLED": "true",
        "TWENTY_SYNC_ENABLED": "true",
        "DB_PATH": "/app/data/whatsapp_crm/crm_v2.db",
        "AVA_PUBLIC_BASE_URL": args.admin_public_url,
        "WHATSAPP_CRM_PUBLIC_URL": args.crm_public_url,
    })
    print(json.dumps({"business_id": args.business_id, "twenty_mode": "shadow", "env_updated": True, "backup": str(backup)}))


if __name__ == "__main__":
    main()
