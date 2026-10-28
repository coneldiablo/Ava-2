import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api import onyx
import auth


@pytest.fixture
def client(monkeypatch):
    captured = []
    class Gateway:
        def issue_approval(self, **kwargs):
            captured.append(kwargs)
            return {"approval_token": "test-only-token"}
        def execute_action(self, **kwargs):
            captured.append(kwargs)
            return {"status": "EXECUTED", "result": {"scheduled": True}}
    monkeypatch.setattr('src.core.onyx_policy_gateway.PolicyGateway', Gateway)
    app = FastAPI()
    app.include_router(onyx.router)
    return TestClient(app), captured, app


def test_approval_and_execution_require_authenticated_operator(client):
    client, _, _ = client
    for path in ['/api/onyx/actions/approvals', '/api/onyx/actions/execute']:
        assert client.post(path, json={}).status_code == 401


def test_approver_cannot_be_forged_in_request_body(client):
    client, captured, app = client
    app.dependency_overrides[auth.get_current_user] = lambda: auth.User(username='real-operator')
    payload = {'business_id': 1, 'agent_id': 'ava:1:agent:sales', 'action': 'make_call',
               'arguments': {'campaign_id': 'campaign', 'phone': '+79990000001'},
               'user_id': 'forged-user', 'approved_by': 'forged-user', 'approval_token': 'test-only-token'}
    assert client.post('/api/onyx/actions/approvals', json=payload).status_code == 200
    assert captured[-1]['approved_by'] == 'real-operator'
    assert client.post('/api/onyx/actions/execute', json=payload).status_code == 200
    assert captured[-1]['user_id'] == 'real-operator'
    assert captured[-1]['approval_token'] == 'test-only-token'
