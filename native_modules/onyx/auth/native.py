"""Community Onyx implementation for the private AVA auth sidecar.

This deliberately calls Onyx's public Community user model and its real
stateful token strategies.  It does not import ``ee`` modules, use an admin
account, or look users up by an AVA-provided email.
"""
from __future__ import annotations

import secrets
import uuid
from contextlib import asynccontextmanager
from typing import Any

from .core import Denied, Unavailable


class CommunityOnyx:
    """Adapter with the small interface consumed by :class:`core.Service`."""

    def __init__(self) -> None:
        try:
            from onyx.auth.schemas import AuthBackend
            from onyx.auth.users import (  # Community source only
                FASTAPI_USERS_AUTH_COOKIE_NAME, AUTH_BACKEND,
                RefreshableDatabaseStrategy, TenantAwareRedisStrategy,
            )
            if AUTH_BACKEND not in (AuthBackend.REDIS, AuthBackend.POSTGRES):
                raise Denied()
            self._backend = AUTH_BACKEND
            self._cookie_name = FASTAPI_USERS_AUTH_COOKIE_NAME
            self._redis_strategy = TenantAwareRedisStrategy
            self._database_strategy = RefreshableDatabaseStrategy
        except ImportError:
            raise Unavailable() from None

    @property
    def cookie_name(self) -> str:
        return self._cookie_name

    @property
    def backend_name(self) -> str:
        return self._backend.value

    @staticmethod
    def _email(native_user_id: str) -> str:
        # An id-derived address is not an identity lookup key.  It is stable,
        # non-routable and collision-free for the deterministic UUID mapping.
        return "ava-" + str(uuid.UUID(native_user_id)) + "@native.invalid"

    async def _user(self, native_user_id: str, *, require_active: bool = True) -> Any:
        from onyx.db.engine.async_sql_engine import get_async_session_context_manager
        from onyx.db.models import User

        uid = uuid.UUID(native_user_id)
        async with get_async_session_context_manager() as session:
            user = await session.get(User, uid)
            if (not user or user.email != self._email(native_user_id)
                    or (require_active and not user.is_active)):
                raise Denied()
            return user

    async def ensure_user(self, native_user_id: str) -> None:
        from onyx.db.engine.async_sql_engine import get_async_session_context_manager
        from onyx.db.enums import AccountType
        from onyx.db.models import User
        from onyx.db.users import assign_user_to_default_groups__no_commit

        uid = uuid.UUID(native_user_id)
        email = self._email(native_user_id)
        async with get_async_session_context_manager() as session:
            existing = await session.get(User, uid)
            if existing:
                # Never merge or repair an unexpected row by email.
                if existing.email != email or existing.account_type != AccountType.STANDARD:
                    raise Denied()
                return
            user = User(id=uid, email=email, hashed_password=secrets.token_urlsafe(48),
                        is_active=True, is_superuser=False, is_verified=True,
                        account_type=AccountType.STANDARD)
            session.add(user)
            await session.flush()
            # Onyx's Community helper assigns Basic when is_admin is false.
            await session.run_sync(
                lambda sync_session: assign_user_to_default_groups__no_commit(
                    sync_session, sync_session.get(User, uid), is_admin=False
                )
            )
            await session.commit()

    async def verify_user(self, native_user_id: str) -> list[str]:
        from onyx.db.enums import AccountType, Permission
        user = await self._user(native_user_id)
        permissions = set(user.effective_permissions or [])
        if user.account_type != AccountType.STANDARD or Permission.BASIC_ACCESS.value not in permissions:
            raise Denied()
        if Permission.FULL_ADMIN_PANEL_ACCESS.value in permissions:
            raise Denied()
        return sorted(permissions)

    @asynccontextmanager
    async def _strategy(self, lifetime_seconds: int):
        if lifetime_seconds < 1:
            raise Denied()
        if self._backend.value == "redis":
            yield self._redis_strategy(lifetime_seconds=lifetime_seconds)
            return
        from fastapi_users_db_sqlalchemy.access_token import SQLAlchemyAccessTokenDatabase
        from onyx.db.engine.async_sql_engine import get_async_session_context_manager
        from onyx.db.models import AccessToken
        async with get_async_session_context_manager() as session:
            yield self._database_strategy(
                SQLAlchemyAccessTokenDatabase(session, AccessToken),
                lifetime_seconds=lifetime_seconds,
            )

    async def write_token(self, native_user_id: str, lifetime_seconds: int) -> str:
        user = await self._user(native_user_id)
        async with self._strategy(lifetime_seconds) as strategy:
            return await strategy.write_token(user)

    async def read_token(self, token: str, native_user_id: str, expires_at: int) -> bool:
        """Read using an actual Onyx UserManager and the row's true TTL.

        ``get_user_manager()`` is a FastAPI dependency and cannot be called
        directly: its default argument is a ``Depends`` sentinel. Construct
        the SQLAlchemy user DB in the live async session instead.
        """
        from fastapi_users_db_sqlalchemy import SQLAlchemyUserDatabase
        from onyx.auth.users import UserManager
        from onyx.db.engine.async_sql_engine import get_async_session_context_manager
        from onyx.db.models import OAuthAccount, User
        remaining = max(1, (expires_at - int(__import__("time").time() * 1000) + 999) // 1000)
        async with get_async_session_context_manager() as session:
            manager = UserManager(SQLAlchemyUserDatabase(session, User, OAuthAccount))
            # A token that merely parses is not accepted. The strategy keeps
            # its stored expiry; this lifetime is only used by the Community
            # strategy constructor and is never shortened to one second.
            async with self._strategy(remaining) as strategy:
                user = await strategy.read_token(token, manager)
        return user is not None and str(user.id) == native_user_id

    async def destroy_token(self, token: str, native_user_id: str) -> None:
        # Disable is intentionally followed by token destruction; inactive
        # identities may not mint/read but their old stateful token must still
        # be destroyed.
        user = await self._user(native_user_id, require_active=False)
        async with self._strategy(1) as strategy:
            await strategy.destroy_token(token, user)

    async def disable_user(self, native_user_id: str) -> None:
        from onyx.db.engine.async_sql_engine import get_async_session_context_manager
        from onyx.db.models import User
        async with get_async_session_context_manager() as session:
            user = await session.get(User, uuid.UUID(native_user_id))
            if not user or user.email != self._email(native_user_id):
                raise Denied()
            user.is_active = False
            await session.commit()

    async def revoke_owned_tokens(self, native_user_id: str) -> bool:
        """Revoke all live stateful tokens for one synthetic UUID, if enumerable.

        Redis is enumerable by scoped key prefix and embeds the native UUID in
        its Community token value. PostgreSQL token enumeration is not a stable
        public Community API at this pinned revision, so it deliberately
        returns false and lets the caller quarantine instead of claiming a
        lost mint was revoked.
        """
        if self._backend.value != "redis":
            return False
        from onyx.auth.session_tokens import classify_session_token_value
        from onyx.redis.redis_pool import get_async_redis_connection
        from onyx.configs.app_configs import REDIS_AUTH_KEY_PREFIX
        user = await self._user(native_user_id, require_active=False)
        redis = await get_async_redis_connection()
        keys = []
        async for key in redis.scan_iter(match=REDIS_AUTH_KEY_PREFIX + "*"):
            raw = await redis.get(key)
            value = classify_session_token_value(raw)
            if getattr(value, "sub", None) == native_user_id:
                token = key.decode() if isinstance(key, bytes) else key
                keys.append(token.removeprefix(REDIS_AUTH_KEY_PREFIX))
        for token in keys:
            await self.destroy_token(token, native_user_id)
        # Re-scan: tombstones are not live values (their `sub` is present but
        # `logged_out_at` means classify returns a rejection without `sub`).
        async for key in redis.scan_iter(match=REDIS_AUTH_KEY_PREFIX + "*"):
            value = classify_session_token_value(await redis.get(key))
            if getattr(value, "sub", None) == native_user_id:
                return False
        return True
