import importlib.util
import sys
from asyncio import run
from pathlib import Path

import pytest
from fastapi import HTTPException


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))


def _reload_auth(monkeypatch, jwt_secret):
    if jwt_secret is None:
        monkeypatch.delenv("JWT_SECRET", raising=False)
    else:
        monkeypatch.setenv("JWT_SECRET", jwt_secret)

    # Do not reload the shared auth module: FastAPI routes retain references to
    # its original dependency functions, which would break later overrides.
    name = "_auth_secret_test_module"
    spec = importlib.util.spec_from_file_location(name, BACKEND_ROOT / "auth.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


def test_jwt_secret_unset_uses_default_dev_secret(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, None)
    assert auth.SECRET_KEY == auth.DEFAULT_DEV_SECRET
    assert auth.USING_PLACEHOLDER_SECRET is True


def test_jwt_secret_empty_uses_default_dev_secret(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, "")
    assert auth.SECRET_KEY == auth.DEFAULT_DEV_SECRET
    assert auth.USING_PLACEHOLDER_SECRET is True


def test_jwt_secret_change_me_please_marked_placeholder(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, "change-me-please")
    assert auth.SECRET_KEY == "change-me-please"
    assert auth.USING_PLACEHOLDER_SECRET is True


def test_jwt_secret_custom_not_placeholder(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, "super-secret-value-123")
    assert auth.SECRET_KEY == "super-secret-value-123"
    assert auth.USING_PLACEHOLDER_SECRET is False


def test_access_token_round_trip_with_pyjwt(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, "super-secret-value-123")
    monkeypatch.setattr(
        auth,
        "get_user",
        lambda username: auth.UserInDB(
            username=username,
            hashed_password="unused",
            disabled=False,
        ),
    )

    token = auth.create_access_token({"sub": "admin"})
    user = run(auth.get_current_user(token))

    assert user.username == "admin"


def test_invalid_access_token_is_rejected(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, "super-secret-value-123")

    with pytest.raises(HTTPException) as exc_info:
        run(auth.get_current_user("not-a-jwt"))

    assert exc_info.value.status_code == 401


def test_disabled_user_token_is_rejected(monkeypatch) -> None:
    auth = _reload_auth(monkeypatch, "test-disabled-user-secret-not-production")
    monkeypatch.setattr(auth, "get_user", lambda username: auth.UserInDB(
        username=username, hashed_password="unused", disabled=True,
    ))
    with pytest.raises(HTTPException) as error:
        run(auth.get_current_user(auth.create_access_token({"sub": "disabled-admin"})))
    assert error.value.status_code == 401
