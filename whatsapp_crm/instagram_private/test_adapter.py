"""Offline contract tests: no instagrapi import, account, or network."""

from types import SimpleNamespace
from datetime import datetime, timezone

import pytest

from .adapter import InstagramPrivateAdapter, InstagramPrivateError


def _message(mid, sender, text, item_type="text"):
    return SimpleNamespace(id=mid, user_id=sender, text=text, item_type=item_type,
                           timestamp=datetime(2026, 9, 23, tzinfo=timezone.utc))


class FakeClient:
    def __init__(self):
        self.calls = []
        self.settings = {"device_settings": {"id": "secret"}}
        self.thread = SimpleNamespace(
            id="340282366841710300949128373114263369599",
            users=[SimpleNamespace(pk="22")],
            messages=[_message("11", "22", "Hello"), _message("12", "22", None, "media")],
        )
        self.failure = None

    def _record(self, name, *args, **kwargs):
        self.calls.append((name, args, kwargs))
        if self.failure:
            raise self.failure

    def set_settings(self, value):
        self._record("set_settings")
        self.settings = value

    def get_settings(self):
        self._record("get_settings")
        return self.settings

    def account_info(self):
        self._record("account_info")
        return SimpleNamespace(pk="22")

    def login(self, *args, **kwargs):
        self._record("login", *args, **kwargs)
        return True

    def direct_threads(self, **kwargs):
        self._record("direct_threads", **kwargs)
        return [self.thread]

    def direct_thread(self, *args, **kwargs):
        self._record("direct_thread", *args, **kwargs)
        return self.thread

    def direct_send(self, *args, **kwargs):
        self._record("direct_send", *args, **kwargs)
        return SimpleNamespace(id="33")


def _adapter():
    client = FakeClient()
    adapter = InstagramPrivateAdapter(enabled=True, client=client)
    adapter.login("owned_account", "private_password")
    return adapter, client


def _code(call, code):
    with pytest.raises(InstagramPrivateError) as caught:
        call()
    assert caught.value.code == code
    assert str(caught.value) == code


def test_disabled_by_default_does_not_construct_client():
    _code(lambda: InstagramPrivateAdapter(client_factory=lambda: 1), "disabled")


def test_login_verification_code_and_no_implicit_login():
    client = FakeClient()
    adapter = InstagramPrivateAdapter(enabled=True, client=client)
    _code(adapter.list_threads, "not_logged_in")
    adapter.login("owned_account", "private_password", "123456")
    assert client.calls == [("login", ("owned_account", "private_password"), {"verification_code": "123456"})]
    _code(lambda: adapter.login("user", "pass", "bad-code"), "invalid_input")


def test_settings_are_copied_and_bounded():
    adapter, client = _adapter()
    source = {"cookie": {"secret": "value"}}
    adapter.set_settings(source)
    source["cookie"]["secret"] = "changed"
    assert client.settings["cookie"]["secret"] == "value"
    result = adapter.get_settings()
    result["cookie"]["secret"] = "changed"
    assert client.settings["cookie"]["secret"] == "value"
    _code(lambda: adapter.set_settings({"oversize": "x" * 262_144}), "invalid_input")


def test_resume_validates_saved_session_without_password():
    client = FakeClient()
    client.user_id = "22"
    adapter = InstagramPrivateAdapter(enabled=True, client=client)
    adapter.resume({"cookie": "session"})
    assert adapter.account_id() == "22"
    assert [name for name, _, _ in client.calls] == ["set_settings", "account_info"]


def test_bounded_text_only_inbox():
    adapter, client = _adapter()
    result = adapter.list_threads(amount=1, messages_per_thread=2)
    assert result == [{"id": client.thread.id, "peer_id": "22", "messages": [{"id": "11", "sender_id": "22", "text": "Hello", "timestamp_ms": 1790121600000}]}]
    assert client.calls[-1] == ("direct_threads", (), {"amount": 1, "thread_message_limit": 2})
    _code(lambda: adapter.list_threads(amount=21), "invalid_input")
    _code(lambda: adapter.list_threads(messages_per_thread=21), "invalid_input")
    client.thread.messages = [_message("11", "22", "a" * 3000)]
    assert len(adapter.list_threads()[0]["messages"][0]["text"]) == 2000


def test_reply_requires_manual_confirmation_and_existing_matching_thread():
    adapter, client = _adapter()
    tid = client.thread.id
    _code(lambda: adapter.reply_to_existing_thread(tid, "Hi"), "manual_confirmation_required")
    assert [name for name, _, _ in client.calls] == ["login"]
    assert adapter.reply_to_existing_thread(tid, "Hi", manually_confirmed=True) == "33"
    assert client.calls[-2] == ("direct_thread", (tid,), {"amount": 1})
    assert client.calls[-1] == ("direct_send", ("Hi",), {"thread_ids": [tid]})
    _code(lambda: adapter.reply_to_existing_thread(tid, "x" * 1001, manually_confirmed=True), "invalid_input")
    client.thread.id = "99"
    _code(lambda: adapter.reply_to_existing_thread(tid, "Hi", manually_confirmed=True), "thread_not_found")
    assert [name for name, _, _ in client.calls].count("direct_send") == 1


@pytest.mark.parametrize(
    ("exception", "code"),
    [
        (type("TwoFactorRequired", (Exception,), {})("secret code"), "two_factor_required"),
        (type("ChallengeRequired", (Exception,), {})("secret password"), "challenge_required"),
        (type("LoginRequired", (Exception,), {})("secret session"), "login_required"),
        (type("ClientThrottledError", (Exception,), {})("secret cookie"), "rate_limited"),
        (type("UnexpectedError", (Exception,), {})("secret token"), "upstream_error"),
    ],
)
def test_upstream_errors_are_redacted_and_sensitive_states_pause(exception, code):
    adapter, client = _adapter()
    client.failure = exception
    _code(adapter.list_threads, code)
    if code == "upstream_error":
        assert not adapter.paused
    else:
        assert adapter.paused
        before = len(client.calls)
        _code(adapter.list_threads, "paused")
        assert len(client.calls) == before


def test_http_429_pauses_without_retry():
    adapter, client = _adapter()
    failure = RuntimeError("private token")
    failure.status_code = 429
    client.failure = failure
    _code(adapter.list_threads, "rate_limited")
    assert adapter.paused
    assert [name for name, _, _ in client.calls].count("direct_threads") == 1


def test_ambiguous_send_response_never_retries():
    adapter, client = _adapter()
    client.direct_send = lambda *args, **kwargs: SimpleNamespace(id=None)
    _code(
        lambda: adapter.reply_to_existing_thread(client.thread.id, "Hi", manually_confirmed=True),
        "send_result_unknown",
    )


def test_transport_failure_during_send_is_unknown_and_fences_the_next_reply():
    adapter, client = _adapter()
    sends=[]
    def fail(*args, **kwargs):
        sends.append(args)
        raise type("ClientRequestTimeout", (Exception,), {})("private")
    client.direct_send=fail
    _code(lambda: adapter.reply_to_existing_thread(client.thread.id,"Reply",manually_confirmed=True),"send_result_unknown")
    _code(lambda: adapter.reply_to_existing_thread(client.thread.id,"Reply",manually_confirmed=True),"paused")
    assert len(sends)==1


@pytest.mark.parametrize("name,code", [("ProxyError", "connection_unavailable"), ("ConnectTimeout", "connection_unavailable"), ("BadPassword", "credentials_invalid")])
def test_connection_failures_are_not_misreported_as_bad_credentials(name, code):
    adapter, client = _adapter()
    client.failure = type(name, (Exception,), {})("must never expose proxy credentials or password")
    _code(adapter.list_threads, code)
    assert not adapter.paused


@pytest.mark.parametrize("failure_name,code", [("ClientRequestTimeout", "connection_unavailable"),
                                               ("ChallengeRequired", "challenge_required")])
def test_native_client_cannot_retry_or_open_interactive_challenge(monkeypatch, failure_name, code):
    import sys
    failure = type(failure_name, (Exception,), {})
    class Native(FakeClient):
        attempts = 0
        retries = 0
        challenges = 0
        options = None
        def __init__(self, **kwargs):
            super().__init__()
            Native.options = kwargs
        def _send_private_request(self, *args, **kwargs):
            Native.attempts += 1
            raise failure("private upstream payload")
        def private_request(self):
            try:
                return self._send_private_request()
            except failure as exc:
                if failure_name == "ClientRequestTimeout":
                    Native.retries += 1
                    return self._send_private_request()
                if self.handle_exception:
                    self.handle_exception(self, exc)
                Native.challenges += 1
        def login(self, *args, **kwargs):
            return self.private_request()
    monkeypatch.setitem(sys.modules, "instagrapi", SimpleNamespace(Client=Native))
    monkeypatch.setenv("INSTAGRAM_PRIVATE_PROXY_URL", "http://proxy.test:8890")
    adapter = InstagramPrivateAdapter(enabled=True)
    _code(lambda: adapter.login("owned", "private-password"), code)
    assert (Native.attempts, Native.retries, Native.challenges) == (1, 0, 0)
    assert Native.options == {"proxy":"http://proxy.test:8890", "session_retry_total":0,
                              "public_request_retries_count":0, "session_retry_statuses":[]}


def test_failed_login_preserves_device_without_password_or_verification_code(monkeypatch):
    from . import worker
    client = FakeClient()
    adapter = InstagramPrivateAdapter(enabled=True, client=client)
    monkeypatch.setattr(worker, "InstagramPrivateAdapter", lambda **_: adapter)
    def fail(*args, **kwargs):
        raise type("TwoFactorRequired", (Exception,), {})("private payload")
    client.login = fail
    settings = {"uuids":{"phone_id":"stable-device"}, "password":"must-not-save",
                "nested":{"verification_code":"123456"}}
    with pytest.raises(InstagramPrivateError) as caught:
        worker.execute({"action":"login", "username":"owned", "password":"private-password",
                        "settings":settings, "code":"123456"})
    assert caught.value.code == "two_factor_required"
    assert caught.value.login_settings == {"uuids":{"phone_id":"stable-device"}, "nested":{}}


def test_prepare_login_creates_no_network_or_authentication_action(monkeypatch):
    from . import worker
    client = FakeClient()
    monkeypatch.setattr(worker, "InstagramPrivateAdapter", lambda **_: InstagramPrivateAdapter(enabled=True,client=client))
    assert worker.execute({"action":"prepare-login"}) == {"settings":client.settings}
    assert [name for name, _, _ in client.calls] == ["get_settings"]
