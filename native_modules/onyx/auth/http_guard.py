"""Optional ASGI boundary for the isolated AVA native-auth Onyx image.

It is installed only when ``AVA_NATIVE_HTTP_GUARD=true``. The gateway strips
all incoming ``x-ava-*`` headers and injects its 43-character secret in
``X-Ava-Native-Peer`` plus one binding and one native cookie.
"""
from __future__ import annotations

import base64
import asyncio
import hmac
import json
import os
import re
import sqlite3
import stat
from pathlib import Path
from typing import Any, Awaitable, Callable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .core import Config, Denied, Unavailable, identifier, integer, read_secret
from .native import CommunityOnyx

ASGIApp = Callable[[dict, Callable[[], Awaitable[dict]], Callable[[dict], Awaitable[None]]], Awaitable[None]]
DEPENDENCY_TIMEOUT_SECONDS = 2
DENIED_PATH_SEGMENTS = frozenset({"auth", "pat", "api-key", "apikey", "admin", "manage"})


class _AccessEnded(Exception):
    """Private control flow: stop downstream work after a terminal response."""


def _header(scope: dict, name: str) -> str | None:
    values = [value for key, value in scope.get("headers", []) if key.lower() == name.encode()]
    if len(values) != 1:
        return None
    try:
        return values[0].decode("ascii")
    except UnicodeDecodeError:
        return None


def _has_header(scope: dict, name: str) -> bool:
    return any(key.lower() == name.encode() for key, _value in scope.get("headers", []))


class NativeHTTPGuard:
    """ASGI middleware which covers HTTP, streaming responses, files and WS."""

    def __init__(self, app: ASGIApp, *, config: Config, state_file: Path,
                 gateway_key_file: str, native: Any | None = None) -> None:
        self.app, self.config, self.state_file = app, config, state_file
        self.gateway_key_file = gateway_key_file
        self.native = native or CommunityOnyx()
        self.cipher = AESGCM(config.key)

    def _state(self, binding_id: str) -> dict:
        if self.state_file.is_symlink():
            raise Unavailable()
        info = self.state_file.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o077:
            raise Unavailable()
        try:
            db = sqlite3.connect(f"file:{self.state_file}?mode=ro", uri=True)
            db.row_factory = sqlite3.Row
            row = db.execute("""
                SELECT c.business_id,c.deployment_id,c.namespace,c.enabled,c.revision AS contour_revision,
                       u.user_id,u.native_user_id,u.revision AS user_revision,u.state AS user_state,
                       s.binding_id,s.revision,s.expires_at,s.state,s.ciphertext
                FROM ava_native_sessions s
                JOIN ava_native_users u ON u.user_id=s.user_id
                JOIN ava_native_contour c ON c.singleton=1
                WHERE s.binding_id=?
            """, (binding_id,)).fetchone()
        except sqlite3.Error:
            raise Unavailable() from None
        finally:
            try:
                db.close()
            except UnboundLocalError:
                pass
        if not row:
            raise Denied()
        value = dict(row)
        if ((value["business_id"], value["deployment_id"], value["namespace"]) !=
                (self.config.business_id, self.config.deployment_id, self.config.namespace)
                or not value["enabled"] or value["user_state"] != "active" or value["state"] != "active"
                or value["revision"] != value["user_revision"] or value["revision"] != value["contour_revision"]):
            raise Denied()
        return value

    def _cookie_token(self, scope: dict) -> str:
        raw = _header(scope, "cookie")
        if raw is None:
            raise Denied()
        name = self.native.cookie_name
        prefix = name + "="
        if not raw.startswith(prefix):
            raise Denied()
        token = raw[len(prefix):]
        if not re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token):
            raise Denied()
        # Canonical single-pair form rejects duplicate names and unrelated
        # cookies rather than allowing a parser to silently collapse them.
        if raw != prefix + token:
            raise Denied()
        return token

    def _decrypt(self, row: dict) -> str:
        try:
            raw = base64.urlsafe_b64decode(row["ciphertext"])
            aad = json.dumps([self.config.business_id, self.config.deployment_id, self.config.namespace,
                              row["binding_id"], row["user_id"], row["revision"]], separators=(",", ":")).encode()
            return self.cipher.decrypt(raw[:12], raw[12:], aad).decode("ascii")
        except Exception:
            raise Unavailable() from None

    async def _authorize(self, scope: dict) -> None:
        if any(_has_header(scope, name) for name in ("authorization", "x-api-key", "api-key", "x-onyx-api-key")):
            # No PAT, API key, JWT, or self-issued bearer alternate may bypass
            # a revoked native session in this isolated image.
            raise Denied()
        path_parts = set(part.lower() for part in scope.get("path", "").split("/") if part)
        # Native SSR needs read-only auth metadata to render an authenticated
        # page. This exception still passes every peer/session check below;
        # login, registration, logout and all other auth routes remain denied.
        auth_metadata = (scope.get("type") == "http" and scope.get("method") == "GET"
                         and scope.get("path") == "/auth/type")
        if path_parts & DENIED_PATH_SEGMENTS and not auth_metadata:
            raise Denied()
        peer_auth = _header(scope, "x-ava-native-peer")
        if not peer_auth:
            raise Denied()
        try:
            supplied = peer_auth.encode("ascii", "strict")
        except UnicodeEncodeError:
            raise Denied() from None
        if not hmac.compare_digest(supplied, read_secret(self.gateway_key_file)):
            raise Denied()
        binding = identifier(_header(scope, "x-ava-native-binding"))
        row = self._state(binding)
        expires_at = row["expires_at"]
        if expires_at <= int(__import__("time").time() * 1000):
            raise Denied()
        token = self._cookie_token(scope)
        stored = self._decrypt(row)
        if not hmac.compare_digest(token, stored):
            raise Denied()
        try:
            valid = await asyncio.wait_for(self.native.read_token(token, row["native_user_id"], expires_at), DEPENDENCY_TIMEOUT_SECONDS)
            if not valid:
                raise Denied()
            # CommunityOnyx verifies AccountType.STANDARD + Basic effective
            # permission and rejects FULL_ADMIN_PANEL_ACCESS.
            await asyncio.wait_for(self.native.verify_user(row["native_user_id"]), DEPENDENCY_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            raise Unavailable() from None
        if not valid:
            raise Denied()

    async def __call__(self, scope: dict, receive: Callable[[], Awaitable[dict]], send: Callable[[dict], Awaitable[None]]) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] == "http" and scope.get("method") == "GET" and scope.get("path") == "/ava-native-healthz":
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"ok":true}'})
            return
        try:
            if scope["type"] not in ("http", "websocket"):
                raise Denied()
            await self._authorize(scope)
        except Denied:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4403})
            else:
                await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"detail":"denied","code":"AVA_NATIVE_HTTP_DENIED"}'})
            return
        except Exception:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4503})
            else:
                await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"detail":"unavailable","code":"AVA_NATIVE_HTTP_UNAVAILABLE"}'})
            return
        # Revalidate at every streaming response boundary and WebSocket send.
        # After an HTTP response has started the only safe action is to stop
        # forwarding body chunks; gateway also owns connection termination.
        started = False
        closed = False

        async def end_access(error: Exception) -> None:
            nonlocal started, closed
            if closed:
                raise _AccessEnded()
            closed = True
            status = 403 if isinstance(error, Denied) else 503
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4403 if status == 403 else 4503})
            elif not started:
                started = True
                await send({"type": "http.response.start", "status": status,
                            "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                await send({"type": "http.response.body", "body": b'{"detail":"access ended","code":"AVA_NATIVE_HTTP_REVOKED"}'})
            else:
                await send({"type": "http.response.body", "body": b"", "more_body": False})
            # Returning would let the generator continue and possibly send
            # after an already final response. Unwind its finally blocks.
            raise _AccessEnded()

        async def guarded_send(message: dict) -> None:
            nonlocal started, closed
            if closed:
                raise _AccessEnded()
            kind = message.get("type")
            if kind in ("http.response.start", "http.response.body", "websocket.accept", "websocket.send"):
                try:
                    await self._authorize(scope)
                except Exception as error:
                    await end_access(error)
            if kind == "http.response.start":
                started = True
            await send(message)

        async def guarded_receive() -> dict:
            if closed:
                raise _AccessEnded()
            message = await receive()
            if scope["type"] == "websocket" and message.get("type") == "websocket.receive":
                try:
                    await self._authorize(scope)
                except Exception as error:
                    await end_access(error)
            return message

        try:
            await self.app(scope, guarded_receive, guarded_send)
        except _AccessEnded:
            pass
        except BaseExceptionGroup as errors:
            # Starlette's streaming task group may wrap our control-flow
            # exception. Suppress only that exception, never unrelated bugs.
            _ended, remaining = errors.split(_AccessEnded)
            if remaining is not None:
                raise remaining


def install_native_http_guard(application: Any) -> None:
    """Install only in the explicitly isolated native-auth image/config."""
    if os.environ.get("AVA_NATIVE_HTTP_GUARD") != "true":
        return
    try:
        business_id = integer(int(os.environ["AVA_BUSINESS_ID"]))
        config = Config(business_id, os.environ["AVA_DEPLOYMENT_ID"], os.environ["AVA_DEPLOYMENT_NAMESPACE"],
                        read_secret(os.environ["AVA_AUTH_ENCRYPTION_KEY_FILE"], key=True))
        state_file = Path(os.environ["AVA_AUTH_STATE_FILE"])
        gateway_key_file = os.environ["AVA_NATIVE_HTTP_GATEWAY_KEY_FILE"]
    except (KeyError, ValueError):
        raise RuntimeError("AVA_NATIVE_HTTP_GUARD_CONFIGURATION_REQUIRED") from None
    application.add_middleware(NativeHTTPGuard, config=config, state_file=state_file, gateway_key_file=gateway_key_file)
