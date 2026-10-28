"""Private adapter protocol and durable, encrypted native-session bindings.

This module intentionally does not import Onyx or Enterprise packages. The real
Onyx implementation lives in native.py; unit fakes are not native acceptance.
The private service has one writer (OS file lock) and serializes state changes.
An unfinished token issue is reconciled by revoking that user's native tokens
before it can issue a replacement; it never guesses that a token was absent.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import time
from typing import Any
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class Denied(Exception):
    code = "AVA_NATIVE_ACCESS_DENIED"


class Unavailable(Exception):
    code = "AVA_NATIVE_DEPENDENCY_UNAVAILABLE"


def identifier(value: Any) -> str:
    if not isinstance(value, str):
        raise Denied()
    try:
        if str(uuid.UUID(value)) != value:
            raise Denied()
    except ValueError:
        raise Denied() from None
    return value


def integer(value: Any, minimum: int = 1) -> int:
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise Denied()
    return value


def exact(data: Any, keys: set[str]) -> dict:
    if not isinstance(data, dict) or set(data) != keys:
        raise Denied()
    return data


def read_secret(path: str, *, key: bool = False) -> bytes:
    # No symlink/argv/env-value secrets. Ordinary files remain owner-only. A
    # service secret may additionally be root-owned 0440 for exactly this
    # process's effective group (the read-only Compose secret-mount contract).
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise Denied() from None
    try:
        meta = os.fstat(fd)
        mode = stat.S_IMODE(meta.st_mode)
        owner_only = meta.st_uid in (0, os.geteuid()) and mode in (0o400, 0o600)
        service_group = meta.st_uid == 0 and meta.st_gid == os.getegid() and mode == 0o440
        if not stat.S_ISREG(meta.st_mode) or not (owner_only or service_group):
            raise Denied()
        raw = os.read(fd, 4097).strip()
        if len(raw) > 4096:
            raise Denied()
    finally:
        os.close(fd)
    if key:
        if not re.fullmatch(rb"[a-f0-9]{64}", raw):
            raise Denied()
        return bytes.fromhex(raw.decode("ascii"))
    if not re.fullmatch(rb"[A-Za-z0-9_-]{43,128}", raw):
        raise Denied()
    return raw


class Config:
    def __init__(self, business_id: int, deployment_id: str, namespace: str, key: bytes):
        self.business_id = integer(business_id)
        self.deployment_id = identifier(deployment_id)
        if not isinstance(namespace, str) or not re.fullmatch(r"ava_[a-f0-9]{32}", namespace) or len(key) != 32:
            raise Denied()
        self.namespace = namespace
        self.key = key

    def scope(self, data: dict) -> None:
        if (data.get("businessId") != self.business_id or type(data.get("businessId")) is not int
                or data.get("deploymentId") != self.deployment_id or data.get("nativeScope") != self.namespace):
            raise Denied()

    def native_id(self, user_id: str) -> str:
        return str(uuid.uuid5(uuid.UUID(self.deployment_id), "ava-user:" + identifier(user_id)))


class Store:
    def __init__(self, path: Path, config: Config):
        self.config = config
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink():
            raise Denied()
        self.lock_fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.lock_fd)
            raise Unavailable() from None
        self.db = sqlite3.connect(path, isolation_level=None, timeout=5)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS ava_native_contour (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                business_id INTEGER NOT NULL, deployment_id TEXT NOT NULL,
                namespace TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS ava_native_users (
                user_id TEXT PRIMARY KEY, native_user_id TEXT NOT NULL UNIQUE,
                subject TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
                revision INTEGER NOT NULL, state TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ava_native_sessions (
                binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ava_native_users(user_id),
                revision INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                state TEXT NOT NULL, ciphertext TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ava_native_sessions_user ON ava_native_sessions(user_id,state);
        """)
        self.db.execute("INSERT OR IGNORE INTO ava_native_contour(singleton,business_id,deployment_id,namespace) VALUES(1,?,?,?)",
                        (config.business_id, config.deployment_id, config.namespace))
        contour = self.contour()
        if (contour["business_id"], contour["deployment_id"], contour["namespace"]) != (
                config.business_id, config.deployment_id, config.namespace):
            self.close()
            raise Denied()
        self.cipher = AESGCM(config.key)

    def close(self) -> None:
        self.db.close()
        fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
        os.close(self.lock_fd)

    def contour(self) -> dict:
        return dict(self.db.execute("SELECT * FROM ava_native_contour WHERE singleton=1").fetchone())

    def user(self, user_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM ava_native_users WHERE user_id=?", (user_id,)).fetchone()
        return dict(row) if row else None

    def session(self, binding_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM ava_native_sessions WHERE binding_id=?", (binding_id,)).fetchone()
        return dict(row) if row else None

    def aad(self, row: dict) -> bytes:
        return json.dumps([self.config.business_id, self.config.deployment_id, self.config.namespace,
                           row["binding_id"], row["user_id"], row["revision"]], separators=(",", ":")).encode()

    def encrypt(self, row: dict, token: str) -> str:
        nonce = secrets.token_bytes(12)
        return base64.urlsafe_b64encode(nonce + self.cipher.encrypt(nonce, token.encode(), self.aad(row))).decode()

    def decrypt(self, row: dict) -> str:
        try:
            raw = base64.urlsafe_b64decode(row["ciphertext"])
            return self.cipher.decrypt(raw[:12], raw[12:], self.aad(row)).decode()
        except Exception:
            raise Unavailable() from None


USER_FIELDS = {"businessId", "deploymentId", "nativeScope", "userId", "subject", "role", "revision"}
SESSION_FIELDS = USER_FIELDS | {"bindingId", "nativeUserId", "expiresAt"}
SCOPE_FIELDS = {"businessId", "deploymentId", "nativeScope", "revision"}


class Service:
    def __init__(self, store: Store, native: Any, clock=None):
        self.store, self.native = store, native
        self.config = store.config
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.lock = asyncio.Lock()

    def _check_user_data(self, data: dict) -> None:
        self.config.scope(data)
        identifier(data["userId"])
        integer(data["revision"])
        if data["role"] not in ("hotel_owner", "manager") or not isinstance(data["subject"], str) or not re.fullmatch(r"[^\x00-\x20\x7f]{1,256}", data["subject"]):
            raise Denied()

    def _matching_user(self, data: dict) -> dict:
        user = self.store.user(data["userId"])
        if not self.store.contour()["enabled"] or not user or user["state"] != "active":
            raise Denied()
        for public, stored in (("subject", "subject"), ("role", "role"), ("revision", "revision"), ("nativeUserId", "native_user_id")):
            if public in data and data[public] != user[stored]:
                raise Denied()
        return user

    def _safe_user(self, user: dict) -> dict:
        return {"businessId": self.config.business_id, "deploymentId": self.config.deployment_id,
                "nativeScope": self.config.namespace, "userId": user["user_id"], "nativeUserId": user["native_user_id"],
                "subject": user["subject"], "role": user["role"], "revision": user["revision"], "state": user["state"]}

    async def provision(self, data: dict) -> dict:
        exact(data, USER_FIELDS)
        self._check_user_data(data)
        async with self.lock:
            contour = self.store.contour()
            if not contour["enabled"] or data["revision"] < contour["revision"]:
                raise Denied()
            now = self.clock()
            user = self.store.user(data["userId"])
            if user:
                if user["subject"] != data["subject"] or data["revision"] < user["revision"]:
                    raise Denied()
                # Per-user disable is terminal for this deployment identity.
                # A delayed or higher-revision provision may not resurrect it;
                # AVA must create a new deployment lifecycle explicitly.
                downgrade = user["role"] == "hotel_owner" and data["role"] == "manager"
                if user["state"] == "disabled" or (user["role"] != data["role"] and not downgrade):
                    raise Denied()
                if data["revision"] > user["revision"] or downgrade or user["state"] == "pending":
                    # Persist the desired lower role before native awaits. A
                    # failed sweep cannot be undone by a stale same-revision
                    # owner request; a manager retry must complete the sweep.
                    self.store.db.execute("UPDATE ava_native_users SET role=?,revision=?,state='pending',updated_at=? WHERE user_id=?",
                                          (data["role"], data["revision"], now, data["userId"]))
                    await self._revoke_user_sessions(user)
                    if not await self.native.revoke_owned_tokens(user["native_user_id"]):
                        raise Unavailable()
            else:
                try:
                    self.store.db.execute("INSERT INTO ava_native_users VALUES(?,?,?,?,?,'pending',?,?)",
                        (data["userId"], self.config.native_id(data["userId"]), data["subject"], data["role"], data["revision"], now, now))
                except sqlite3.IntegrityError:
                    raise Denied() from None
            user = self.store.user(data["userId"])
            await self.native.ensure_user(user["native_user_id"])
            await self.native.verify_user(user["native_user_id"])
            self.store.db.execute("UPDATE ava_native_users SET state='active',updated_at=? WHERE user_id=?", (self.clock(), user["user_id"]))
            return self._safe_user(self.store.user(user["user_id"]))

    async def create_session(self, data: dict) -> dict:
        exact(data, SESSION_FIELDS)
        self._check_user_data(data)
        identifier(data["bindingId"])
        identifier(data["nativeUserId"])
        integer(data["expiresAt"])
        if not self.clock() < data["expiresAt"] <= self.clock() + 24 * 60 * 60 * 1000:
            raise Denied()
        async with self.lock:
            user = self._matching_user(data)
            await self.native.verify_user(user["native_user_id"])
            row = self.store.session(data["bindingId"])
            if row:
                if (row["user_id"], row["revision"], row["expires_at"]) != (data["userId"], data["revision"], data["expiresAt"]):
                    raise Denied()
                if row["state"] != "active":
                    # A lost mint response is reconciled before reuse; a revoked
                    # binding is never resurrected. Broker must issue a new one.
                    if row["state"] in ("issuing", "revoking"):
                        await self._revoke_user_sessions(user)
                    raise Denied()
                token = self.store.decrypt(row)
                if not await self.native.read_token(token, user["native_user_id"], row["expires_at"]):
                    self.store.db.execute("UPDATE ava_native_sessions SET state='revoked',ciphertext=NULL WHERE binding_id=?", (row["binding_id"],))
                    raise Denied()
                return self._session_result(row, user, token)
            # A previous process may have died after native mint but before
            # ciphertext persistence. Revoke all native tokens for this owned
            # identity; it is safer to sign out another tab than leak a session.
            if self.store.db.execute("SELECT 1 FROM ava_native_sessions WHERE user_id=? AND state IN ('issuing','revoking') LIMIT 1", (user["user_id"],)).fetchone():
                await self._revoke_user_sessions(user)
            now = self.clock()
            self.store.db.execute("INSERT INTO ava_native_sessions VALUES(?,?,?,?,'issuing',NULL,?,?)",
                                  (data["bindingId"], data["userId"], data["revision"], data["expiresAt"], now, now))
            row = self.store.session(data["bindingId"])
            token = None
            try:
                token = await self.native.write_token(user["native_user_id"], max(1, (data["expiresAt"] - self.clock()) // 1000))
                if not re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token or "") or not await self.native.read_token(token, user["native_user_id"], data["expiresAt"]):
                    raise Unavailable()
                self._matching_user(data)
                if self.clock() >= row["expires_at"]:
                    raise Denied()
                ciphertext = self.store.encrypt(row, token)
                self.store.db.execute("UPDATE ava_native_sessions SET state='active',ciphertext=?,updated_at=? WHERE binding_id=? AND state='issuing'",
                                      (ciphertext, self.clock(), row["binding_id"]))
            except Exception:
                # Keep intent durable if dependency cleanup cannot be proved.
                if token:
                    with contextlib.suppress(Exception):
                        await self.native.destroy_token(token, user["native_user_id"])
                raise
            return self._session_result(row, user, token)

    def _session_result(self, row: dict, user: dict, token: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", self.native.cookie_name):
            raise Unavailable()
        return {"businessId": self.config.business_id, "deploymentId": self.config.deployment_id,
                "bindingId": row["binding_id"], "userId": user["user_id"], "nativeUserId": user["native_user_id"],
                "nativeScope": self.config.namespace, "nativeCookie": self.native.cookie_name + "=" + token,
                "nativeSessionId": hashlib.sha256(token.encode()).hexdigest()}

    async def revoke(self, data: dict) -> dict:
        exact(data, {"bindingId"})
        identifier(data["bindingId"])
        async with self.lock:
            row = self.store.session(data["bindingId"])
            if not row:
                # This adapter never minted it: don't manufacture an absence
                # receipt for a possibly mismatched adapter/deployment.
                raise Denied()
            if row["state"] != "revoked":
                user = self.store.user(row["user_id"])
                self.store.db.execute("UPDATE ava_native_sessions SET state='revoking',updated_at=? WHERE binding_id=?",
                                      (self.clock(), row["binding_id"]))
                if row["ciphertext"]:
                    token = self.store.decrypt(row)
                    await self.native.destroy_token(token, user["native_user_id"])
                    if await self.native.read_token(token, user["native_user_id"], row["expires_at"]):
                        raise Unavailable()
                    self.store.db.execute("UPDATE ava_native_sessions SET state='revoked',ciphertext=NULL,updated_at=? WHERE binding_id=?",
                                          (self.clock(), row["binding_id"]))
                else:
                    await self._revoke_user_sessions(user)
            return {"bindingId": row["binding_id"], "nativeSessionAbsent": True}

    async def _revoke_user_sessions(self, user: dict) -> None:
        self.store.db.execute("UPDATE ava_native_sessions SET state='revoking' WHERE user_id=? AND state!='revoked'", (user["user_id"],))
        # An `issuing` record without ciphertext may be a token minted just
        # before a process crash. It is unknown, not absent. Ask the native
        # backend to enumerate and revoke this synthetic identity's tokens;
        # if that backend cannot prove the sweep, quarantine the identity and
        # preserve the pending row rather than issue a false receipt.
        unknown = self.store.db.execute(
            "SELECT 1 FROM ava_native_sessions WHERE user_id=? AND state='revoking' AND ciphertext IS NULL LIMIT 1",
            (user["user_id"],),
        ).fetchone()
        if unknown and not await self.native.revoke_owned_tokens(user["native_user_id"]):
            await self.native.disable_user(user["native_user_id"])
            raise Unavailable()
        # Every known token is durably recorded and must be individually
        # destroyed then read back with its actual configured lifetime.
        rows = self.store.db.execute(
            "SELECT * FROM ava_native_sessions WHERE user_id=? AND state='revoking' AND ciphertext IS NOT NULL",
            (user["user_id"],),
        ).fetchall()
        for value in rows:
            row = dict(value)
            token = self.store.decrypt(row)
            await self.native.destroy_token(token, user["native_user_id"])
            if await self.native.read_token(token, user["native_user_id"], row["expires_at"]):
                raise Unavailable()
        self.store.db.execute("UPDATE ava_native_sessions SET state='revoked',ciphertext=NULL,updated_at=? WHERE user_id=?",
                              (self.clock(), user["user_id"]))

    async def disable(self, data: dict) -> dict:
        exact(data, SCOPE_FIELDS)
        self.config.scope(data)
        integer(data["revision"])
        async with self.lock:
            contour = self.store.contour()
            if data["revision"] < contour["revision"]:
                raise Denied()
            self.store.db.execute("UPDATE ava_native_contour SET enabled=0,revision=? WHERE singleton=1", (data["revision"],))
            self.store.db.execute("UPDATE ava_native_users SET state='disabled',updated_at=?", (self.clock(),))
            await self._cleanup_disabled()
            return {**data, "state": "disabled", "nativeSessionsAbsent": True}

    async def disable_user(self, data: dict) -> dict:
        """Terminally disable exactly one previously provisioned AVA user.

        The durable local fence is committed before any native await. A lost
        response is therefore recovered by ``recover`` or an idempotent retry;
        it can never become an invitation to re-provision the identity.
        """
        exact(data, USER_FIELDS)
        self._check_user_data(data)
        async with self.lock:
            contour = self.store.contour()
            user = self.store.user(data["userId"])
            if (not contour["enabled"] or not user
                    or user["subject"] != data["subject"]
                    or user["role"] != data["role"]
                    or user["revision"] != data["revision"]):
                raise Denied()
            self.store.db.execute(
                "UPDATE ava_native_users SET state='disabled',updated_at=? WHERE user_id=?",
                (self.clock(), user["user_id"]),
            )
            user = self.store.user(user["user_id"])
            await self._cleanup_disabled_user(user)
            return {**self._safe_user(self.store.user(user["user_id"])), "nativeSessionsAbsent": True}

    async def _cleanup_disabled_user(self, user: dict) -> None:
        await self.native.disable_user(user["native_user_id"])
        await self._revoke_user_sessions(user)
        # Known session rows are not a complete token inventory: a process may
        # have minted a token before its issuing row/ciphertext was durable.
        # A per-user absence receipt therefore requires an enumerable final
        # sweep even when no issuing row currently exposes that risk.
        if not await self.native.revoke_owned_tokens(user["native_user_id"]):
            raise Unavailable()
        try:
            await self.native.verify_user(user["native_user_id"])
        except Denied:
            pass
        else:
            raise Unavailable()

    async def _cleanup_disabled(self) -> None:
        for row in self.store.db.execute("SELECT * FROM ava_native_users WHERE state='disabled'").fetchall():
            await self._cleanup_disabled_user(dict(row))

    async def reconcile(self, data: dict) -> dict:
        exact(data, SCOPE_FIELDS)
        self.config.scope(data)
        integer(data["revision"])
        async with self.lock:
            if data["revision"] != self.store.contour()["revision"]:
                raise Denied()
            await self._recover()
            return {**data, "state": "verified" if self.store.contour()["enabled"] else "disabled"}

    async def _recover(self) -> None:
        await self._cleanup_disabled()
        users = self.store.db.execute("SELECT DISTINCT u.* FROM ava_native_users u JOIN ava_native_sessions s ON s.user_id=u.user_id WHERE s.state IN ('issuing','revoking') OR (s.state='active' AND s.expires_at<=?)", (self.clock(),)).fetchall()
        for row in users:
            await self._revoke_user_sessions(dict(row))

    async def recover(self) -> None:
        async with self.lock:
            await self._recover()

    async def verify(self, data: dict) -> dict:
        exact(data, USER_FIELDS)
        self._check_user_data(data)
        async with self.lock:
            user = self._matching_user(data)
            proof = await self.native.verify_user(user["native_user_id"])
            return {**self._safe_user(user), "nativeIdentityVerified": True, "permissions": proof,
                    "statefulSessionBackend": self.native.backend_name,
                    "nativeLoginVerified": False, "storageAclVerified": False}
