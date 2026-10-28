"""Contract tests for manager handoff (task 11).

AVA itself never owns the handoff task: it only records evidence that a call
needs a human and hands it to the CRM through the existing post-call webhook.
These tests pin that contract from the runtime side.
"""

import json
from pathlib import Path

import pytest
import yaml

from src.core.models import CallSession
from src.engine import Engine
from src.tools.context import PostCallContext


ROOT = Path(__file__).resolve().parents[2]

HANDOFF_REASONS = {
    "guest_request",
    "missing_fact",
    "booking_change",
    "booking_request",
    "complaint",
    "payment",
    "sensitive_data",
    "repeated_misunderstanding",
    "transfer_failed",
    "manual",
    "other",
}


def make_engine():
    return Engine.__new__(Engine)


def make_session(call_id="call-handoff", business_id=2):
    return CallSession(
        call_id=call_id,
        caller_channel_id=f"caller-{call_id}",
        caller_number="79990000001",
        context_name="unified_sales_agent",
        business_id=business_id,
    )


# ─── Session-side signal recording ────────────────────────────────────────


def test_session_starts_without_handoff_signals():
    session = make_session()
    assert session.handoff_signals == []


def test_failed_transfer_signal_carries_target_and_dial_status():
    engine = make_engine()
    session = make_session()

    engine._record_handoff_signal(
        session,
        "transfer_failed",
        target="SIP/reception",
        status="NOANSWER",
    )

    assert len(session.handoff_signals) == 1
    signal = session.handoff_signals[0]
    assert signal["type"] == "transfer_failed"
    assert signal["target"] == "SIP/reception"
    assert signal["status"] == "NOANSWER"
    assert signal["at"], "signal is timestamped so the CRM can order events"


def test_handoff_signal_skips_empty_details():
    engine = make_engine()
    session = make_session()

    engine._record_handoff_signal(session, "transfer_failed", target=None, status="")

    signal = session.handoff_signals[0]
    assert "target" not in signal
    assert "status" not in signal


def test_handoff_signals_are_bounded_against_retry_storms():
    engine = make_engine()
    session = make_session()

    for index in range(25):
        engine._record_handoff_signal(session, "transfer_failed", target=f"SIP/{index}")

    assert len(session.handoff_signals) == 10
    # The most recent attempts are the ones that survive.
    assert session.handoff_signals[-1]["target"] == "SIP/24"


def test_recording_a_signal_never_raises_on_a_broken_session():
    engine = make_engine()

    class Frozen:
        call_id = "call-frozen"

        @property
        def handoff_signals(self):
            return []

    # Assigning to a read-only property raises; the call must not be affected.
    engine._record_handoff_signal(Frozen(), "transfer_failed", target="SIP/reception")


# ─── Post-call payload contract ───────────────────────────────────────────


def test_post_call_payload_exposes_handoff_signals_as_json():
    signals = [{"type": "transfer_failed", "target": "SIP/reception", "status": "BUSY"}]
    context = PostCallContext(
        call_id="call-1",
        caller_number="79990000001",
        business_id=2,
        handoff_signals=signals,
    )

    payload = context.to_payload_dict()

    assert json.loads(payload["handoff_signals_json"]) == signals


def test_post_call_payload_defaults_to_an_empty_signal_list():
    context = PostCallContext(call_id="call-2", caller_number="79990000001")

    assert json.loads(context.to_payload_dict()["handoff_signals_json"]) == []


def test_sales_brain_post_call_template_forwards_handoff_signals():
    config = yaml.safe_load((ROOT / "config/ai-agent.yaml").read_text(encoding="utf-8"))
    template = config["tools"]["sales_brain_post_call"]["payload_template"]

    assert '"handoff_signals": {handoff_signals_json}' in template

    # The template must stay valid JSON once the runtime fills it in.
    rendered = (
        template
        .replace("{handoff_signals_json}", '[{"type":"transfer_failed"}]')
        .replace("{transcript_json}", "[]")
        .replace("{summary_json}", '"ok"')
        .replace("{tool_calls_json}", "[]")
        .replace("{outbound_custom_vars_json}", "{}")
        .replace("{call_duration}", "12")
    )
    import re

    rendered = re.sub(r"\$\{[A-Z_][A-Z0-9_]*\}", "x", rendered)
    rendered = re.sub(r"\{[a-z_]+\}", "x", rendered)
    parsed = json.loads(rendered)
    assert parsed["handoff_signals"] == [{"type": "transfer_failed"}]


# ─── MCP tool contract ────────────────────────────────────────────────────


def test_manager_task_tool_exposes_reason_and_keeps_scope():
    from src.mcp_servers import sales_brain_mcp_server as server

    tool = next(
        item for item in server._tools_list()["tools"]
        if item["name"] == "create_manager_task"
    )
    properties = tool["inputSchema"]["properties"]

    assert set(properties["reason"]["enum"]) == HANDOFF_REASONS
    assert "instance_id" in properties
    # reason stays optional so the existing voice contract does not break.
    assert set(tool["inputSchema"]["required"]) == {"phone", "task"}


def test_manager_task_tool_forwards_reason_and_instance_scope(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []
    monkeypatch.setattr(
        server,
        "_post_json",
        lambda path, payload: calls.append((path, dict(payload))) or {"success": True, "spoken": "ok"},
    )

    server._handle_call(
        "create_manager_task",
        {
            "phone": "+79990000001",
            "task": "Перезвонить гостю по трансферу",
            "priority": "high",
            "reason": "transfer_failed",
            "call_id": "call-42",
            "instance_id": 7,
        },
    )

    path, payload = calls[0]
    assert path == "/api/ml/manager-task"
    assert payload["instanceId"] == 7
    assert payload["reason"] == "transfer_failed"
    assert payload["callId"] == "call-42"
    assert payload["priority"] == "high"


def test_manager_task_tool_omits_reason_when_not_supplied(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []
    monkeypatch.setattr(
        server,
        "_post_json",
        lambda path, payload: calls.append((path, dict(payload))) or {"success": True, "spoken": "ok"},
    )

    server.create_manager_task("+79990000001", "Связаться с гостем", instance_id=3)

    _, payload = calls[0]
    assert "reason" not in payload, "the CRM defaults an absent reason to 'manual'"
    assert payload["instanceId"] == 3


# ─── The handoff stays inside existing tools ──────────────────────────────


def test_hotel_scenario_handoff_does_not_name_internal_tools():
    pack = yaml.safe_load((ROOT / "config/scenarios/hotel.yaml").read_text(encoding="utf-8"))
    scenario = next(
        item for item in pack["inbound"]["scenarios"]
        if item["id"] == "manager_handoff"
    )
    guidance = " ".join(scenario["guidance"]).lower()

    for forbidden in ("create_manager_task", "mcp_sales", "transfer(", "instanceid"):
        assert forbidden not in guidance, f"prompt must not leak {forbidden} to the model as an API name"


def test_unified_sales_agent_still_only_uses_existing_handoff_tools():
    config = yaml.safe_load((ROOT / "config/ai-agent.yaml").read_text(encoding="utf-8"))
    tools = config["contexts"]["unified_sales_agent"]["tools"]

    # Task 11 adds no new voice tool: the handoff rides on what already exists.
    assert "mcp_sales_create_manager_task" in tools
    assert "transfer" in tools
    assert not [name for name in tools if "handoff" in name]


# ─── Admin UI proxy contract ──────────────────────────────────────────────


def test_admin_ui_task_routes_require_an_explicit_business_scope():
    source = (ROOT / "admin_ui/backend/api/tasks.py").read_text(encoding="utf-8")

    assert 'business_id: int = Query(..., ge=1' in source, "business_id is mandatory, never inferred"
    assert '"/api/ml/manager-tasks"' in source
    assert source.count("Query(..., ge=1") == 2, "both list and update are scoped"


@pytest.mark.parametrize("status", sorted({"new", "in_progress", "done", "cancelled"}))
def test_admin_ui_and_crm_agree_on_task_statuses(status):
    backend = (ROOT / "admin_ui/backend/api/tasks.py").read_text(encoding="utf-8")
    crm = (ROOT / "whatsapp_crm/src/utils/constants.js").read_text(encoding="utf-8")

    assert f'"{status}"' in backend
    assert f"'{status}'" in crm
