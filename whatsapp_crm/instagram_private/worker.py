"""Single request worker. Secrets enter on stdin; argv and stderr stay secret-free."""

from __future__ import annotations

import json
import sys

from .adapter import InstagramPrivateAdapter, InstagramPrivateError


def execute(request: dict) -> dict:
    adapter = InstagramPrivateAdapter(enabled=True)
    action = request.get("action")
    if action == "prepare-login":
        settings = adapter.login_retry_settings()
        if settings is None:
            raise InstagramPrivateError("invalid_upstream_data")
        return {"settings": settings}
    if action == "login":
        if request.get("settings") is not None:
            adapter.set_settings(request["settings"])
        try:
            adapter.login(request.get("username"), request.get("password"), request.get("code"))
        except InstagramPrivateError as error:
            error.login_settings = adapter.login_retry_settings()
            raise
        return {"account_id": adapter.account_id(), "settings": adapter.get_settings()}
    adapter.resume(request.get("settings"))
    account_id = adapter.account_id()
    if action == "poll":
        return {"account_id": account_id, "threads": adapter.list_threads(amount=20, messages_per_thread=20),
                "settings": adapter.get_settings()}
    if action == "reply":
        return {"account_id": account_id, "message_id": adapter.reply_to_existing_thread(
            request.get("thread_id"), request.get("text"), manually_confirmed=True),
            "settings": adapter.get_settings()}
    raise InstagramPrivateError("invalid_input")


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.readline(524289))
        if not isinstance(request, dict):
            raise InstagramPrivateError("invalid_input")
        result = {"ok": True, "data": execute(request)}
    except InstagramPrivateError as error:
        result = {"ok": False, "code": error.code}
        if getattr(error, "login_settings", None) is not None:
            result["login_settings"] = error.login_settings
    except Exception:
        result = {"ok": False, "code": "worker_error"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
