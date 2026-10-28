#!/usr/bin/env python3
"""Bounded operator proof for one isolated, native Onyx customer entry.

Run this only inside the recipe's ``auth`` container.  It talks to the real
local peer on 4011 and the real guarded API on 8080; it does not read auth
state, mint tokens itself, use a browser, or write application/CRM data.
The supplied manifest is the sole source of the customer principal.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid


MAX_MANIFEST = 8192
MAX_RESPONSE = 16 * 1024
AUTH_URL = "http://127.0.0.1:4011"
API_URL = "http://api:8080"
MANIFEST_KEYS = frozenset(("schemaVersion", "kind", "businessId", "deploymentId", "nativeScope", "revision", "principal"))
PRINCIPAL_KEYS = frozenset(("userId", "subject", "role"))
PROVISION_KEYS = frozenset(("businessId", "deploymentId", "nativeScope", "userId", "nativeUserId", "subject", "role", "revision", "state"))
SESSION_KEYS = frozenset(("businessId", "deploymentId", "bindingId", "userId", "nativeUserId", "nativeScope", "nativeCookie", "nativeSessionId"))
RECEIPT_KEYS = frozenset(("schema_version", "ok", "business_id", "deployment_id", "namespace", "revision",
                          "operator_user_id", "checks", "browser_storage_verified", "limitation"))
CHECKS = frozenset((
    "operator_manifest_exact_scope", "native_user_provisioned", "temporary_session_created",
    "me_authorized", "auth_type_authorized", "missing_peer_denied", "wrong_peer_denied",
    "missing_binding_denied", "wrong_binding_denied", "foreign_business_native_auth_denied",
    "manage_admin_denied", "auth_login_denied", "session_revoked", "old_token_after_revoke_denied",
    "web_transport_and_identity",
))


class VerificationError(Exception):
    """A fixed, non-sensitive failure boundary for operator execution."""


def _uuid(value: Any) -> str:
    if not isinstance(value, str):
        raise VerificationError()
    try:
        if str(uuid.UUID(value)) != value:
            raise VerificationError()
    except ValueError:
        raise VerificationError() from None
    return value


def _positive_int(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= 2**53 - 1:
        raise VerificationError()
    return value


def runtime_scope(environ: dict[str, str] | None = None) -> dict[str, Any]:
    environ = os.environ if environ is None else environ
    try:
        business_id = _positive_int(int(environ["AVA_BUSINESS_ID"]))
        deployment_id = _uuid(environ["AVA_DEPLOYMENT_ID"])
        revision = _positive_int(int(environ["AVA_DEPLOYMENT_REVISION"]))
        namespace = environ["AVA_DEPLOYMENT_NAMESPACE"]
    except (KeyError, ValueError):
        raise VerificationError() from None
    if namespace != "ava_" + deployment_id.replace("-", ""):
        raise VerificationError()
    return {"businessId": business_id, "deploymentId": deployment_id,
            "nativeScope": namespace, "revision": revision}


def read_operator_manifest(path: Path, scope: dict[str, Any]) -> dict[str, Any]:
    """Read one non-writable, exact operator manifest, never browser input."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise VerificationError() from None
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid())
                or info.st_mode & 0o022 or info.st_size > MAX_MANIFEST):
            raise VerificationError()
        raw = os.read(fd, MAX_MANIFEST + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_MANIFEST:
        raise VerificationError()
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        raise VerificationError() from None
    if not isinstance(value, dict) or set(value) != MANIFEST_KEYS:
        raise VerificationError()
    if (type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1
            or type(value.get("businessId")) is not int or type(value.get("revision")) is not int
            or value.get("kind") != "ava_onyx_customer_entry_operator"):
        raise VerificationError()
    if any(value.get(key) != scope[key] for key in scope):
        raise VerificationError()
    principal = value.get("principal")
    if not isinstance(principal, dict) or set(principal) != PRINCIPAL_KEYS:
        raise VerificationError()
    _uuid(principal.get("userId"))
    if (not isinstance(principal.get("subject"), str)
            or not re.fullmatch(r"[^\x00-\x20\x7f]{1,256}", principal["subject"])
            or principal.get("role") not in ("hotel_owner", "manager")):
        raise VerificationError()
    return value


def _read_peer_secret(name: str) -> str:
    path = os.environ.get(name)
    if not path:
        raise VerificationError()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise VerificationError() from None
    try:
        meta = os.fstat(fd)
        allowed = ((meta.st_uid in (0, os.geteuid()) and stat.S_IMODE(meta.st_mode) in (0o400, 0o600))
                   or (meta.st_uid == 0 and meta.st_gid == os.getegid() and stat.S_IMODE(meta.st_mode) == 0o440))
        if not stat.S_ISREG(meta.st_mode) or not allowed:
            raise VerificationError()
        raw = os.read(fd, 4097).strip()
    finally:
        os.close(fd)
    try:
        secret = raw.decode("ascii", "strict")
    except UnicodeDecodeError:
        raise VerificationError() from None
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", secret):
        raise VerificationError()
    return secret


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = build_opener(ProxyHandler({}), NoRedirect())


def request(url: str, *, method: str = "POST", body: dict[str, Any] | None = None,
            headers: dict[str, str] | None = None) -> tuple[int, dict[str, Any] | None]:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    req = Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        response = _OPENER.open(req, timeout=10)
    except HTTPError as error:
        response = error
    except (URLError, OSError):
        raise VerificationError() from None
    with response:
        raw = response.read(MAX_RESPONSE + 1)
        status = response.status
    if len(raw) > MAX_RESPONSE:
        raise VerificationError()
    if not raw:
        return status, None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return status, None
    return status, parsed if isinstance(parsed, dict) else None


def _peer(path: str, peer_secret: str, body: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    return request(AUTH_URL + path, body=body, headers={"Authorization": "Bearer " + peer_secret})


def _denied(url: str, headers: dict[str, str]) -> bool:
    return request(url, method="GET", headers=headers)[0] == 403


def _web_render(headers: dict[str, str], native_user_id: str) -> bool:
    # The pinned UI fetches user data client-side; the SSR HTML intentionally
    # does not serialize the user ID. Verify its actual API rewrite as well.
    me_status, me = request('http://web:3000/api/me', method='GET', headers=headers)
    req = Request('http://web:3000/app', headers=headers, method='GET')
    try:
        with _OPENER.open(req, timeout=20) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            # RSC includes inactive not-found redirect boundaries too. Neither
            # their presence nor status 200 proves a usable browser page.
            # This check is deliberately transport + authenticated API only.
            return (response.status == 200 and len(raw) <= 2 * 1024 * 1024
                    and 'text/html' in response.headers.get('Content-Type', '')
                    and me_status == 200 and isinstance(me, dict) and me.get('id') == native_user_id
                    and headers['X-Ava-Native-Peer'].encode('ascii') not in raw
                    and headers['Cookie'].encode('ascii') not in raw)
    except HTTPError as error:
        print(json.dumps({"web_probe": {"status": error.code,
            "redirect_to_auth": '/auth/' in error.headers.get('Location', '')}}), file=sys.stderr)
        return False
    except (URLError, OSError):
        return False


def _exact(value: dict[str, Any] | None, keys: frozenset[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise VerificationError()
    return value


def validate_receipt(value: Any, scope: dict[str, Any], operator_user_id: str) -> dict[str, Any]:
    """Keep the evidence boundary as strict as the live peer receipts."""
    if not isinstance(value, dict) or set(value) != RECEIPT_KEYS:
        raise VerificationError()
    if (value.get("schema_version") != 1 or value.get("ok") is not True
            or value.get("business_id") != scope["businessId"]
            or value.get("deployment_id") != scope["deploymentId"]
            or value.get("namespace") != scope["nativeScope"]
            or value.get("revision") != scope["revision"]
            or value.get("operator_user_id") != operator_user_id
            or value.get("browser_storage_verified") is not False
            or value.get("limitation") != "no_browser_or_storage_proof"
            or not isinstance(value.get("checks"), dict)
            or set(value["checks"]) != CHECKS
            or not all(item is True for item in value["checks"].values())):
        raise VerificationError()
    return value


def run(manifest_path: Path) -> dict[str, Any]:
    scope = runtime_scope()
    manifest = read_operator_manifest(manifest_path, scope)
    principal = manifest["principal"]
    user = {**scope, **principal}
    gateway = _read_peer_secret("AVA_AUTH_GATEWAY_KEY_FILE")
    worker = _read_peer_secret("AVA_AUTH_WORKER_KEY_FILE")
    checks = {key: False for key in CHECKS}
    checks["operator_manifest_exact_scope"] = True

    provision_status, provision = _peer("/v1/provision", worker, user)
    provision = _exact(provision, PROVISION_KEYS)
    if (provision_status != 200 or any(provision[key] != user[key] for key in user)
            or provision["state"] != "active"):
        raise VerificationError()
    native_user_id = _uuid(provision["nativeUserId"])
    checks["native_user_provisioned"] = True

    binding_id = str(uuid.uuid4())
    session_body = {**user, "bindingId": binding_id, "nativeUserId": native_user_id,
                    "expiresAt": int(time.time() * 1000) + 120_000}
    session_status, session = _peer("/v1/sessions/create", gateway, session_body)
    session = _exact(session, SESSION_KEYS)
    if (session_status != 200 or any(session[key] != session_body[key] for key in
                                     ("businessId", "deploymentId", "bindingId", "userId", "nativeUserId", "nativeScope"))
            or not isinstance(session["nativeCookie"], str) or not isinstance(session["nativeSessionId"], str)):
        raise VerificationError()
    checks["temporary_session_created"] = True

    # Keep the secret material local and short-lived.  It is never part of a
    # receipt, an exception, a command argument, or a log message.
    guarded = {"X-Ava-Native-Peer": gateway, "X-Ava-Native-Binding": binding_id,
               "Cookie": session["nativeCookie"]}
    try:
        me_status, me = request(API_URL + "/me", method="GET", headers=guarded)
        checks["me_authorized"] = me_status == 200 and isinstance(me, dict) and me.get("id") == native_user_id
        checks["auth_type_authorized"] = request(API_URL + "/auth/type", method="GET", headers=guarded)[0] == 200
        checks["web_transport_and_identity"] = _web_render(guarded, native_user_id)
        checks["missing_peer_denied"] = _denied(API_URL + "/me", {key: value for key, value in guarded.items() if key != "X-Ava-Native-Peer"})
        checks["wrong_peer_denied"] = _denied(API_URL + "/me", {**guarded, "X-Ava-Native-Peer": "x" * 43})
        checks["missing_binding_denied"] = _denied(API_URL + "/me", {key: value for key, value in guarded.items() if key != "X-Ava-Native-Binding"})
        checks["wrong_binding_denied"] = _denied(API_URL + "/me", {**guarded, "X-Ava-Native-Binding": str(uuid.uuid4())})
        foreign_status, _foreign = _peer("/v1/provision", worker, {**user, "businessId": scope["businessId"] + 1})
        checks["foreign_business_native_auth_denied"] = foreign_status == 403
        checks["manage_admin_denied"] = _denied(API_URL + "/manage/admin", guarded)
        checks["auth_login_denied"] = _denied(API_URL + "/auth/login", guarded)
        revoke_status, revoked = _peer("/v1/sessions/revoke", gateway, {"bindingId": binding_id})
        checks["session_revoked"] = revoke_status == 200 and revoked == {"bindingId": binding_id, "nativeSessionAbsent": True}
        checks["old_token_after_revoke_denied"] = _denied(API_URL + "/me", guarded)
    finally:
        # A failed probe must still attempt to revoke the exact temporary
        # binding.  Its result is deliberately not emitted unless validated.
        if not checks["session_revoked"]:
            try:
                _peer("/v1/sessions/revoke", gateway, {"bindingId": binding_id})
            except VerificationError:
                pass
    if not all(checks.values()):
        print(json.dumps({"failed_checks": sorted(key for key, passed in checks.items() if not passed)}), file=sys.stderr)
        raise VerificationError()
    return validate_receipt({"schema_version": 1, "ok": True, "business_id": scope["businessId"],
                             "deployment_id": scope["deploymentId"], "namespace": scope["nativeScope"],
                             "revision": scope["revision"], "operator_user_id": principal["userId"],
                             "checks": checks, "browser_storage_verified": False,
                             "limitation": "no_browser_or_storage_proof"}, scope, principal["userId"])


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="explicitly run the native HTTP proof")
    parser.add_argument("--operator-manifest", type=Path, required=True,
                        help="read-only trusted operator manifest mounted in the isolated container")
    args = parser.parse_args(argv)
    if not args.run:
        parser.error("--run is required")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        print(json.dumps(run(args.operator_manifest), sort_keys=True, separators=(",", ":")))
        return 0
    except (VerificationError, OSError, ValueError):
        print("ONYX_CUSTOMER_ENTRY_VERIFICATION_FAILED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
