import sys
from asyncio import run
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from api import hotels  # noqa: E402


def test_smoke_test_uses_long_running_crm_timeout(monkeypatch) -> None:
    captured = {}

    async def fake_crm_request(method, path, payload=None, *, timeout_seconds=10.0):
        captured.update(
            method=method,
            path=path,
            payload=payload,
            timeout_seconds=timeout_seconds,
        )
        return {"success": True}

    monkeypatch.setattr(hotels, "_crm_request", fake_crm_request)

    response = run(hotels.run_hotel_knowledge_base_smoke_test(7, {"questions": []}))

    assert response == {"success": True}
    assert captured == {
        "method": "POST",
        "path": "/api/ml/hotel-profiles/7/knowledge-base/smoke-test",
        "payload": {"questions": []},
        "timeout_seconds": 180.0,
    }
