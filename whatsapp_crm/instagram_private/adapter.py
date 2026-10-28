"""Small, deliberately manual wrapper around instagrapi Direct messages.

No client is created or network request made unless the caller explicitly opts in.
Exceptions from the upstream library are never exposed to callers or logs.
"""

from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime
from typing import Any, Callable, Mapping


MAX_THREADS = 20
MAX_MESSAGES_PER_THREAD = 20
MAX_MESSAGE_TEXT = 2000
MAX_REPLY_TEXT = 1000
MAX_SETTINGS_BYTES = 262_144


class InstagramPrivateError(Exception):
    """A safe status code, never an upstream exception or account detail."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _positive_id(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise InstagramPrivateError("invalid_input")
    candidate = str(value)
    if not re.fullmatch(r"[1-9][0-9]{0,39}", candidate):
        raise InstagramPrivateError("invalid_input")
    return candidate


def _bounded_count(value: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise InstagramPrivateError("invalid_input")
    return value


def _safe_text(value: Any, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise InstagramPrivateError("invalid_input")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise InstagramPrivateError("invalid_input")
    return value


def _status_code(exc: Exception) -> int | None:
    for source in (exc, getattr(exc, "response", None)):
        if source is None:
            continue
        status = getattr(source, "status_code", None)
        if isinstance(status, int):
            return status
    return None


def _error_code(exc: Exception) -> str:
    if isinstance(exc, InstagramPrivateError):
        return exc.code
    # Class names and HTTP status only; exception messages can contain secrets.
    names = {cls.__name__.lower() for cls in type(exc).__mro__}
    if any("twofactor" in name or "two_factor" in name for name in names):
        return "two_factor_required"
    if any("challenge" in name for name in names):
        return "challenge_required"
    if any("loginrequired" in name or "login_required" in name for name in names) or _status_code(exc) == 401:
        return "login_required"
    if _status_code(exc) == 429 or names.intersection(
        {"clientthrottlederror", "pleasewaitfewminutes", "ratelimiterror", "toomanyrequests"}
    ):
        return "rate_limited"
    if names.intersection({"proxyerror", "connectionerror", "connecttimeout", "readtimeout", "timeouterror", "timeout",
                           "clientrequesttimeout", "clientincompletereaderror", "clientconnectionerror", "curlerror"}):
        return "connection_unavailable"
    if names.intersection({"badpassword", "invaliduser", "invalidcredentials"}):
        return "credentials_invalid"
    return "upstream_error"


def _service_client(proxy_url: str | None):
    from instagrapi import Client

    class ServiceClient(Client):
        def challenge_resolve(self, *args, **kwargs):
            raise InstagramPrivateError("challenge_required")

        def _send_private_request(self, *args, **kwargs):
            try:
                return super()._send_private_request(*args, **kwargs)
            except Exception as exc:
                # The pinned library sleeps 60 seconds before repeating these
                # failures. AVA owns retries and must preserve unknown sends.
                if _error_code(exc) == "connection_unavailable":
                    raise InstagramPrivateError("connection_unavailable") from None
                raise

    def manual_verification(_client, exc):
        # Prevent the library from opening an interactive challenge flow on
        # the worker's stdin or making a second request after an auth failure.
        raise exc

    client = ServiceClient(proxy=proxy_url, session_retry_total=0,
                           public_request_retries_count=0, session_retry_statuses=[])
    client.handle_exception = manual_verification
    def manual_challenge(*_args, **_kwargs):
        raise InstagramPrivateError("challenge_required")
    client.challenge_code_handler = manual_challenge
    client.change_password_handler = manual_challenge
    return client


class InstagramPrivateAdapter:
    """Single-account, opt-in adapter; no retries, polling, or automatic replies.

    ``client`` is injectable for isolated tests. Without it, instagrapi is
    imported and instantiated only when ``enabled=True`` is supplied.
    """

    def __init__(
        self,
        *,
        enabled: bool = False,
        client: Any | None = None,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        if not enabled:
            raise InstagramPrivateError("disabled")
        if client is not None and client_factory is not None:
            raise InstagramPrivateError("invalid_input")
        if client is not None:
            self._client = client
        else:
            if client_factory is None:
                try:
                    import instagrapi  # noqa: F401
                except ImportError:
                    raise InstagramPrivateError("dependency_missing") from None
                proxy_url = os.environ.get("INSTAGRAM_PRIVATE_PROXY_URL")
                client_factory = lambda: _service_client(proxy_url)
            try:
                self._client = client_factory()
            except Exception:
                raise InstagramPrivateError("client_error") from None
        self._paused = False
        self._logged_in = False

    @property
    def paused(self) -> bool:
        return self._paused

    def _call(self, operation: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        if self._paused:
            raise InstagramPrivateError("paused")
        try:
            return operation(*args, **kwargs)
        except Exception as exc:
            code = _error_code(exc)
            if code in {"two_factor_required", "challenge_required", "rate_limited", "login_required"}:
                self._paused = True
                self._logged_in = False
            raise InstagramPrivateError(code) from None

    def _require_login(self) -> None:
        if self._paused:
            raise InstagramPrivateError("paused")
        if not self._logged_in:
            raise InstagramPrivateError("not_logged_in")

    def set_settings(self, settings: Mapping[str, Any]) -> None:
        """Accept caller-owned session settings; caller must store them securely."""
        if not isinstance(settings, Mapping):
            raise InstagramPrivateError("invalid_input")
        try:
            serialized = json.dumps(settings, ensure_ascii=False, allow_nan=False)
            if len(serialized.encode("utf-8")) > MAX_SETTINGS_BYTES:
                raise InstagramPrivateError("invalid_input")
            safe_settings = json.loads(serialized)
        except (TypeError, ValueError, OverflowError):
            raise InstagramPrivateError("invalid_input") from None
        self._call(self._client.set_settings, safe_settings)
        configure_retries = getattr(self._client, "set_retry_config", None)
        if callable(configure_retries):
            self._call(configure_retries, session_retry_total=0, public_request_retries_count=0,
                       session_retry_statuses=[])

    def get_settings(self) -> dict[str, Any]:
        """Return secret session data to the caller, never log or persist it."""
        self._require_login()
        settings = self._call(self._client.get_settings)
        if not isinstance(settings, dict):
            raise InstagramPrivateError("invalid_upstream_data")
        try:
            serialized = json.dumps(settings, ensure_ascii=False, allow_nan=False)
            if len(serialized.encode("utf-8")) > MAX_SETTINGS_BYTES:
                raise InstagramPrivateError("invalid_upstream_data")
            return copy.deepcopy(settings)
        except (TypeError, ValueError, OverflowError):
            raise InstagramPrivateError("invalid_upstream_data") from None

    def login_retry_settings(self) -> dict[str, Any] | None:
        """Preserve device identity after a failed login, never input secrets."""
        try:
            value = self._client.get_settings()
            def strip_inputs(item):
                if isinstance(item, dict):
                    return {key: strip_inputs(child) for key, child in item.items()
                            if str(key).casefold() not in {"password", "verification_code", "verificationcode"}}
                if isinstance(item, list):
                    return [strip_inputs(child) for child in item]
                return item
            if not isinstance(value, dict):
                return None
            value = strip_inputs(value)
            data = json.dumps(value, ensure_ascii=False, allow_nan=False)
            return json.loads(data) if len(data.encode("utf-8")) <= MAX_SETTINGS_BYTES else None
        except Exception:
            return None

    def login(self, username: str, password: str, verification_code: str | None = None) -> None:
        _safe_text(username, 100)
        _safe_text(password, 1024)
        if verification_code is not None:
            if not isinstance(verification_code, str) or not re.fullmatch(r"[0-9]{6,8}", verification_code):
                raise InstagramPrivateError("invalid_input")
        kwargs = {"verification_code": verification_code} if verification_code else {}
        result = self._call(self._client.login, username, password, **kwargs)
        if not result:
            raise InstagramPrivateError("login_failed")
        self._logged_in = True

    def resume(self, settings: Mapping[str, Any]) -> None:
        """Validate a saved session without accepting or retaining a password."""
        self.set_settings(settings)
        self._call(self._client.account_info)
        self._logged_in = True

    def account_id(self) -> str:
        self._require_login()
        return _positive_id(getattr(self._client, "user_id", None))

    def list_threads(self, *, amount: int = 10, messages_per_thread: int = 10) -> list[dict[str, Any]]:
        """Read only the normal inbox; text messages only, no media/requests."""
        self._require_login()
        amount = _bounded_count(amount, MAX_THREADS)
        messages_per_thread = _bounded_count(messages_per_thread, MAX_MESSAGES_PER_THREAD)
        threads = self._call(
            self._client.direct_threads,
            amount=amount,
            thread_message_limit=messages_per_thread,
        )
        if not isinstance(threads, (list, tuple)):
            raise InstagramPrivateError("invalid_upstream_data")
        result: list[dict[str, Any]] = []
        for thread in threads[:amount]:
            try:
                thread_id = _positive_id(getattr(thread, "id"))
                users = getattr(thread, "users", None)
                if not isinstance(users, (list, tuple)) or len(users) != 1:
                    continue
                peer_id = _positive_id(getattr(users[0], "pk"))
                raw_messages = getattr(thread, "messages", None) or []
                if not isinstance(raw_messages, (list, tuple)):
                    continue
                messages: list[dict[str, str]] = []
                for message in raw_messages[:messages_per_thread]:
                    if getattr(message, "item_type", None) != "text":
                        continue
                    body = getattr(message, "text", None)
                    if not isinstance(body, str) or not body:
                        continue
                    message_id = _positive_id(getattr(message, "id"))
                    timestamp = getattr(message, "timestamp", None)
                    if not isinstance(timestamp, datetime) or timestamp.tzinfo is None:
                        continue
                    messages.append({
                        "id": message_id,
                        "sender_id": _positive_id(getattr(message, "user_id")),
                        "text": body[:MAX_MESSAGE_TEXT],
                        "timestamp_ms": int(timestamp.timestamp() * 1000),
                    })
                result.append({"id": thread_id, "peer_id": peer_id, "messages": messages})
            except (AttributeError, InstagramPrivateError):
                # Unexpected upstream objects are skipped, never stringified.
                continue
        return result

    def reply_to_existing_thread(self, thread_id: str | int, text: str, *, manually_confirmed: bool = False) -> str:
        """One explicit human-approved reply; never starts a new conversation."""
        self._require_login()
        if manually_confirmed is not True:
            raise InstagramPrivateError("manual_confirmation_required")
        tid = _positive_id(thread_id)
        body = _safe_text(text, MAX_REPLY_TEXT)
        # Verify existence immediately before sending; no user_ids/new threads.
        existing = self._call(self._client.direct_thread, tid, amount=1)
        try:
            if _positive_id(getattr(existing, "id")) != tid:
                raise InstagramPrivateError("thread_not_found")
        except AttributeError:
            raise InstagramPrivateError("thread_not_found") from None
        try:
            sent = self._call(self._client.direct_send, body, thread_ids=[tid])
        except InstagramPrivateError as exc:
            if exc.code in {"connection_unavailable", "upstream_error", "invalid_upstream_data"}:
                self._paused = True
                self._logged_in = False
                raise InstagramPrivateError("send_result_unknown") from None
            raise
        try:
            return _positive_id(getattr(sent, "id"))
        except (AttributeError, InstagramPrivateError):
            # Do not retry: an ambiguous response may still have delivered.
            raise InstagramPrivateError("send_result_unknown") from None
