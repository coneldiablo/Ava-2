"""Contract tests for WhatsApp follow-up approval (task 12).

The runtime may draft a follow-up and queue it, but it can never deliver one:
approval lives in the CRM and belongs to a human. These tests pin the parts of
that contract that live on the AVA side.
"""

from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]

DRAFT_STATUSES = {"draft", "approved", "sent", "rejected", "failed"}


# ─── MCP tool contract ────────────────────────────────────────────────────


def test_followup_tools_keep_tenant_scope_and_confirmation():
    from src.mcp_servers import sales_brain_mcp_server as server

    tools = {item["name"]: item for item in server._tools_list()["tools"]}

    draft = tools["draft_whatsapp_followup"]
    send = tools["send_whatsapp_followup"]

    assert "instance_id" in draft["inputSchema"]["properties"]
    assert "instance_id" in send["inputSchema"]["properties"]
    # Confirmation stays mandatory on the tool; approval is enforced separately.
    assert "confirmed" in send["inputSchema"]["required"]


def test_send_tool_description_does_not_promise_delivery():
    from src.mcp_servers import sales_brain_mcp_server as server

    tools = {item["name"]: item for item in server._tools_list()["tools"]}
    description = tools["send_whatsapp_followup"]["description"].lower()

    # The model must not believe this tool puts a message in front of a guest.
    assert "approval" in description
    assert "does not deliver" in description
    assert tools["draft_whatsapp_followup"]["description"].lower().endswith("does not send.")


def test_send_tool_forwards_scope_and_confirmation(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []
    monkeypatch.setattr(
        server,
        "_post_json",
        lambda path, payload: calls.append((path, dict(payload))) or {"success": True, "spoken": "ok"},
    )

    server._handle_call(
        "send_whatsapp_followup",
        {"phone": "+79990000001", "text": "Детали", "confirmed": True, "instance_id": 5},
    )

    path, payload = calls[0]
    assert path == "/api/ml/followup/send"
    assert payload["instanceId"] == 5
    assert payload["confirmed"] is True


def test_draft_tool_forwards_scope(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []
    monkeypatch.setattr(
        server,
        "_post_json",
        lambda path, payload: calls.append((path, dict(payload))) or {"success": True, "spoken": "ok"},
    )

    server.draft_whatsapp_followup("+79990000001", "Текст", instance_id=9)

    path, payload = calls[0]
    assert path == "/api/ml/followup/draft"
    assert payload["instanceId"] == 9


# ─── Prompt-level policy ──────────────────────────────────────────────────


def test_hotel_pack_forbids_claiming_the_message_was_sent():
    pack = yaml.safe_load((ROOT / "config/scenarios/hotel.yaml").read_text(encoding="utf-8"))
    rules = " ".join(pack["safety_rules"]).lower()

    assert "не отправляешь whatsapp сама" in rules
    assert "уже отправила" in rules, "the pack names the exact phrase the agent must avoid"


def test_hotel_pack_still_requires_guest_consent_for_followup():
    pack = yaml.safe_load((ROOT / "config/scenarios/hotel.yaml").read_text(encoding="utf-8"))
    rules = " ".join(pack["safety_rules"]).lower()

    # Task 12 tightens delivery; it must not loosen the consent rule from task 10.
    assert "только по запросу гостя" in rules
    assert "только после явного подтверждения" in rules


def test_unified_sales_agent_keeps_both_followup_tools():
    config = yaml.safe_load((ROOT / "config/ai-agent.yaml").read_text(encoding="utf-8"))
    tools = config["contexts"]["unified_sales_agent"]["tools"]

    # The allowlist is unchanged: the policy moved into the CRM, not the config.
    assert "mcp_sales_draft_whatsapp_followup" in tools
    assert "mcp_sales_send_whatsapp_followup" in tools


# ─── Admin UI proxy contract ──────────────────────────────────────────────


def test_admin_ui_followup_routes_require_an_explicit_business_scope():
    source = (ROOT / "admin_ui/backend/api/followups.py").read_text(encoding="utf-8")

    assert source.count("Query(..., ge=1") == 2, "both list and action are scoped"
    assert '"/api/ml/followup-drafts"' in source


def test_admin_ui_only_exposes_review_actions():
    source = (ROOT / "admin_ui/backend/api/followups.py").read_text(encoding="utf-8")

    assert 'DRAFT_ACTIONS = ("edit", "approve", "reject")' in source
    # No raw send endpoint: delivery is only ever a consequence of approval.
    assert "/followups/send" not in source


@pytest.mark.parametrize("status", sorted(DRAFT_STATUSES))
def test_admin_ui_and_crm_agree_on_draft_statuses(status):
    backend = (ROOT / "admin_ui/backend/api/followups.py").read_text(encoding="utf-8")
    crm = (ROOT / "whatsapp_crm/src/utils/constants.js").read_text(encoding="utf-8")

    assert f'"{status}"' in backend
    assert f"'{status}'" in crm


def test_sent_is_a_terminal_status_in_the_crm():
    crm = (ROOT / "whatsapp_crm/src/utils/constants.js").read_text(encoding="utf-8")

    # A delivered message can never transition anywhere: the guest already has it.
    assert "sent: []" in crm
