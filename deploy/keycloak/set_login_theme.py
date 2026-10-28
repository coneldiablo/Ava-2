"""Read or switch the AVA realm login theme without printing credentials.

Run on the identity host with its private .env. No secrets are passed in argv.
"""

import argparse
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "http://127.0.0.1:8084"


def read_private_env(path: Path) -> dict[str, str]:
    if path.stat().st_mode & 0o077:
        raise RuntimeError("identity environment file must be private")
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def request_json(url: str, *, data: bytes | None = None, token: str | None = None, method: str | None = None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/json" if token else "application/x-www-form-urlencoded"
    request = Request(url, data=data, headers=headers, method=method)
    with urlopen(request, timeout=10) as response:
        payload = response.read()
        return json.loads(payload) if payload else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path("/opt/ava-identity/.env"))
    parser.add_argument("--set", choices=("ava", "keycloak"), help="Set a reviewed theme")
    args = parser.parse_args()
    try:
        env = read_private_env(args.env_file)
        credentials = urlencode({
            "client_id": "admin-cli",
            "grant_type": "password",
            "username": env["AVA_IDENTITY_BOOTSTRAP_USERNAME"],
            "password": env["AVA_IDENTITY_BOOTSTRAP_PASSWORD"],
        }).encode()
        token = request_json(f"{BASE_URL}/realms/master/protocol/openid-connect/token", data=credentials)["access_token"]
        realm_url = f"{BASE_URL}/admin/realms/ava"
        before = request_json(realm_url, token=token).get("loginTheme") or "keycloak"
        if args.set:
            request_json(realm_url, data=json.dumps({"loginTheme": args.set}).encode(), token=token, method="PUT")
        after = request_json(realm_url, token=token).get("loginTheme") or "keycloak"
        print(f"AVA login theme: {before} -> {after}")
        if args.set and after != args.set:
            raise RuntimeError("Keycloak did not persist the requested theme")
    except (HTTPError, URLError, KeyError) as exc:
        # Never print response bodies, URLs with query strings, or credentials.
        code = getattr(exc, "code", None)
        raise SystemExit(f"Theme update failed ({type(exc).__name__}{f' {code}' if code else ''})") from None


if __name__ == "__main__":
    main()
