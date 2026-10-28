"""Configure the live AVA realm SMTP from the private identity environment.

Run on the identity host. The script authenticates to SMTP without sending an
email, backs up the current realm, and verifies the Keycloak readback.
"""

import json
import os
import smtplib
import ssl
from datetime import datetime, timezone
from email.utils import parseaddr
from pathlib import Path
from urllib.parse import urlencode

from set_login_theme import BASE_URL, read_private_env, request_json


ENV_FILE = Path("/opt/ava-identity/.env")
REALM_URL = f"{BASE_URL}/admin/realms/ava"


def smtp_settings(env: dict[str, str]) -> dict[str, str]:
    keys = ("SYSTEM_SMTP_HOST", "SYSTEM_SMTP_PORT", "SYSTEM_SMTP_SECURE",
            "SYSTEM_SMTP_USER", "SYSTEM_SMTP_PASS", "SYSTEM_SMTP_FROM")
    if any(not env.get(key) for key in keys):
        raise RuntimeError("private identity environment is missing SMTP settings")
    if env["SYSTEM_SMTP_SECURE"].lower() != "true" or env["SYSTEM_SMTP_PORT"] != "465":
        raise RuntimeError("this deployment requires implicit TLS on port 465")
    name, address = parseaddr(env["SYSTEM_SMTP_FROM"])
    if not name or address.lower() != env["SYSTEM_SMTP_USER"].lower():
        raise RuntimeError("SMTP sender must match the authenticated mailbox")
    return {"host": env["SYSTEM_SMTP_HOST"], "port": env["SYSTEM_SMTP_PORT"],
            "ssl": "true", "starttls": "false", "auth": "true",
            "user": env["SYSTEM_SMTP_USER"], "password": env["SYSTEM_SMTP_PASS"],
            "from": address, "fromDisplayName": name}


def backup_realm(realm: dict) -> Path:
    backup_dir = ENV_FILE.parent / "backups"
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = backup_dir / f"realm-ava-before-smtp-{stamp}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(realm, stream)
        stream.write("\n")
    return path


def main() -> None:
    env = read_private_env(ENV_FILE)
    smtp = smtp_settings(env)
    with smtplib.SMTP_SSL(smtp["host"], int(smtp["port"]), timeout=12,
                          context=ssl.create_default_context()) as connection:
        connection.login(smtp["user"], smtp["password"])

    credentials = urlencode({"client_id": "admin-cli", "grant_type": "password",
                             "username": env["AVA_IDENTITY_BOOTSTRAP_USERNAME"],
                             "password": env["AVA_IDENTITY_BOOTSTRAP_PASSWORD"]}).encode()
    token = request_json(f"{BASE_URL}/realms/master/protocol/openid-connect/token",
                         data=credentials)["access_token"]
    realm = request_json(REALM_URL, token=token)
    if realm.get("registrationAllowed") is not False or realm.get("verifyEmail") is not False:
        raise RuntimeError("realm registration or verification policy changed; review before update")
    actions = request_json(f"{REALM_URL}/authentication/required-actions", token=token)
    if not any(item.get("alias") == "VERIFY_EMAIL" and item.get("enabled") for item in actions):
        raise RuntimeError("VERIFY_EMAIL required action is unavailable")

    backup = backup_realm(realm)
    request_json(REALM_URL, data=json.dumps({"smtpServer": smtp}).encode(),
                 token=token, method="PUT")
    after = request_json(REALM_URL, token=token)
    expected = {key: value for key, value in smtp.items() if key != "password"}
    if any(after.get("smtpServer", {}).get(key) != value for key, value in expected.items()):
        raise RuntimeError("Keycloak SMTP readback differs from requested settings")
    if after.get("registrationAllowed") is not False or after.get("verifyEmail") is not False:
        raise RuntimeError("realm registration or verification policy changed unexpectedly")
    print(f"SMTP authentication and Keycloak readback succeeded; backup: {backup}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # SMTP and HTTP exception messages can contain server data or secrets.
        raise SystemExit(f"SMTP configuration failed ({type(exc).__name__})") from None
