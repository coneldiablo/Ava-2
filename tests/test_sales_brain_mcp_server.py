import pytest


@pytest.mark.unit
def test_sales_brain_customer_summary_uses_ml_endpoint(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []

    def fake_post(path, payload):
        calls.append((path, payload))
        return {
            "success": True,
            "spoken": "Клиент Мевлюд. Статус: qualified.",
            "customer_id": "crm_1_1",
        }

    monkeypatch.setattr(server, "_post_json", fake_post)

    result = server.customer_summary("+7 928 534-88-31", instance_id=1)

    assert calls == [("/api/ml/customer/summary", {"phone": "+7 928 534-88-31", "instanceId": 1})]
    assert result["structured"]["status"] == "ok"
    assert "qualified" in result["structured"]["spoken"]


@pytest.mark.unit
def test_sales_brain_rag_answer_unwraps_nested_result(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    monkeypatch.setattr(
        server,
        "_post_json",
        lambda path, payload: {
            "success": True,
            "result": {
                "spoken": "Завтрак с 8 до 11.",
                "citations": [{"document_id": "1", "chunk_id": "2"}],
            },
        },
    )

    result = server.answer_from_knowledge("Во сколько завтрак?", instance_id=1)

    assert result["structured"]["status"] == "ok"
    assert result["structured"]["spoken"] == "Завтрак с 8 до 11."
    assert result["structured"]["output"]["result"]["citations"][0]["chunk_id"] == "2"


@pytest.mark.unit
def test_sales_brain_send_followup_requires_confirmation_passthrough(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    def fake_post(path, payload):
        assert path == "/api/ml/followup/send"
        assert payload["confirmed"] is False
        return {
            "success": False,
            "status": "needs_confirmation",
            "spoken": "Перед отправкой WhatsApp-сообщения нужно подтверждение.",
        }

    monkeypatch.setattr(server, "_post_json", fake_post)

    result = server.send_whatsapp_followup("79285348831", "Текст", confirmed=False, instance_id=1)

    assert result["structured"]["status"] == "needs_confirmation"
    assert "подтверждение" in result["structured"]["spoken"]


@pytest.mark.unit
def test_sales_brain_tools_expose_core_voice_actions():
    from src.mcp_servers import sales_brain_mcp_server as server

    tools = server._tools_list()["tools"]
    names = {tool["name"] for tool in tools}

    assert "customer_summary" in names
    assert "answer_from_knowledge" in names
    assert "create_crm_note" in names
    assert "send_whatsapp_followup" in names


@pytest.mark.unit
def test_sales_brain_stage_update_preserves_server_injected_call_admission(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server
    calls = []
    monkeypatch.setattr(server, "_post_json", lambda path, payload: calls.append((path, payload)) or {"success": True})
    server._handle_call("update_stage", {"phone": "79990000001", "stage": "qualified", "reason": "Потребность уточнена", "instance_id": 7, "call_id": "actual-call"})
    assert calls == [("/api/ml/stage/update", {"phone": "79990000001", "stage": "qualified", "reason": "Потребность уточнена", "instanceId": 7, "callId": "actual-call"})]
    tool = next(tool for tool in server._tools_list()["tools"] if tool["name"] == "update_stage")
    assert "call_id" in tool["inputSchema"]["properties"]
