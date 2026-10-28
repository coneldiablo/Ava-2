import pytest
from datetime import datetime, timezone


@pytest.mark.unit
@pytest.mark.p0
def test_sales_brain_voice_tools_forward_explicit_instance_scope(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []

    def fake_post(path, payload):
        calls.append((path, dict(payload)))
        return {"success": True, "spoken": "ok"}

    monkeypatch.setattr(server, "_post_json", fake_post)

    server.resolve_customer("+79990000001", instance_id=11)
    server.customer_summary("+79990000001", instance_id=12)
    server.get_timeline("+79990000001", instance_id=13, limit=3)
    server.answer_from_knowledge("Во сколько завтрак?", instance_id=14)
    server.get_next_action("+79990000001", instance_id=15)
    server.create_crm_note("+79990000001", "note", call_id="call-1", instance_id=16)
    server.create_manager_task("+79990000001", "task", call_id="call-1", instance_id=17)
    server.update_stage("+79990000001", "qualified", "reason", instance_id=18)
    server.draft_whatsapp_followup("+79990000001", "draft", instance_id=19)
    server.send_whatsapp_followup("+79990000001", "send", confirmed=True, instance_id=20)

    assert [payload["instanceId"] for _, payload in calls] == list(range(11, 21))
    assert ("/api/ml/rag/answer", {"question": "Во сколько завтрак?", "channel": "voice", "instanceId": 14}) in calls


@pytest.mark.unit
@pytest.mark.p0
def test_sales_brain_and_whatsapp_mcp_tools_expose_instance_scope():
    from src.mcp_servers import sales_brain_mcp_server, whatsapp_crm_mcp_server

    for tool in sales_brain_mcp_server._tools_list()["tools"]:
        assert "instance_id" in tool["inputSchema"]["properties"], tool["name"]

    for tool in whatsapp_crm_mcp_server._tools_list()["tools"]:
        assert "instance_id" in tool["inputSchema"]["properties"], tool["name"]


@pytest.mark.asyncio
async def test_knowledge_mcp_forwards_real_caller_not_model_identity(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server
    from src.tools.context import ToolExecutionContext
    from src.tools.mcp_tool import MCPTool, MCPToolBehavior
    calls = []
    def post(path, payload):
        calls.append((path, payload))
        return {'spoken': 'ok'}
    monkeypatch.setattr(server, '_post_json', post)
    class Manager:
        async def call_tool(self, *, tool_name, arguments, **kwargs):
            return server._handle_call(tool_name, arguments)
    schema = next(tool for tool in server._tools_list()['tools'] if tool['name'] == 'answer_from_knowledge')
    tool = MCPTool(exposed_name='answer_from_knowledge', server_id='sales_brain',
                   mcp_tool_name='answer_from_knowledge', description='Knowledge',
                   input_schema=schema['inputSchema'], manager=Manager(), behavior=MCPToolBehavior())
    await tool.execute({'question': 'Завтрак?', 'instance_id': 999, 'caller_number': '+79990000999', 'call_id': 'model-call'},
                       ToolExecutionContext(call_id='actual-call', business_id=22, caller_number='+79990000001'))
    assert calls == [('/api/ml/rag/answer', {'question': 'Завтрак?', 'channel': 'voice', 'instanceId': 22,
                                            'callerNumber': '+79990000001', 'callId': 'actual-call'})]

@pytest.mark.unit
@pytest.mark.p0
def test_same_whatsapp_phone_has_different_history_per_instance(monkeypatch):
    from src.mcp_servers import whatsapp_crm_mcp_server as server

    monkeypatch.setattr(server, "_api_token", lambda: "")

    same_phone_chat = "79990000001@c.us"
    clients_by_instance = {
        "1": {
            "success": True,
            "clients": [
                {
                    "chatId": same_phone_chat,
                    "senderName": "Hotel One Guest",
                    "leadStatus": "qualified",
                    "lastMessage": "Нужен ранний заезд.",
                }
            ],
        },
        "2": {
            "success": True,
            "clients": [
                {
                    "chatId": same_phone_chat,
                    "senderName": "Hotel Two Guest",
                    "leadStatus": "booked",
                    "lastMessage": "Нужен трансфер.",
                }
            ],
        },
    }
    messages_by_instance = {
        "1": {
            "success": True,
            "messages": [
                {"role": "user", "senderName": "Guest", "content": "Нужен ранний заезд.", "timestamp": "2026-07-01T10:00:00Z"},
                {"role": "assistant", "senderName": "AVA", "content": "Проверю ранний заезд.", "timestamp": "2026-07-01T10:01:00Z"},
            ],
        },
        "2": {
            "success": True,
            "messages": [
                {"role": "user", "senderName": "Guest", "content": "Нужен трансфер.", "timestamp": "2026-07-01T11:00:00Z"},
                {"role": "assistant", "senderName": "AVA", "content": "Уточню детали трансфера.", "timestamp": "2026-07-01T11:01:00Z"},
            ],
        },
    }

    def fake_get(path):
        parts = path.split("/")
        if path.startswith("/api/clients/"):
            return clients_by_instance[parts[-1]]
        if path.startswith("/api/messages/"):
            return messages_by_instance[parts[3]]
        raise AssertionError(path)

    monkeypatch.setattr(server, "_http_get_json", fake_get)

    hotel_one_lookup = server.lookup_whatsapp_client("+7 999 000-00-01", instance_id=1)
    hotel_two_lookup = server.lookup_whatsapp_client("+7 999 000-00-01", instance_id=2)
    hotel_one_summary = server.summarize_whatsapp_conversation("+7 999 000-00-01", instance_id=1)
    hotel_two_summary = server.summarize_whatsapp_conversation("+7 999 000-00-01", instance_id=2)

    assert hotel_one_lookup["structured"]["client"]["senderName"] == "Hotel One Guest"
    assert hotel_two_lookup["structured"]["client"]["senderName"] == "Hotel Two Guest"
    assert "ранний заезд" in hotel_one_summary["structured"]["spoken"]
    assert "трансфер" in hotel_two_summary["structured"]["spoken"]
    assert hotel_one_summary["structured"]["spoken"] != hotel_two_summary["structured"]["spoken"]


@pytest.mark.asyncio
@pytest.mark.p0
async def test_outbound_same_phone_is_leased_only_inside_selected_campaign(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")

    from src.core.outbound_store import OutboundStore

    store = OutboundStore(db_path=str(tmp_path / "call_history.db"))
    hotel_one = await store.create_campaign({"name": "Hotel One", "timezone": "UTC", "default_context": "hotel_one"})
    hotel_two = await store.create_campaign({"name": "Hotel Two", "timezone": "UTC", "default_context": "hotel_two"})
    csv_bytes = b"phone_number,name\n+79990000001,Shared Phone\n"

    assert (await store.import_leads_csv(hotel_one["id"], csv_bytes))["accepted"] == 1
    assert (await store.import_leads_csv(hotel_two["id"], csv_bytes))["accepted"] == 1

    hotel_one_leads = await store.list_leads(hotel_one["id"])
    hotel_two_leads = await store.list_leads(hotel_two["id"])
    assert hotel_one_leads["total"] == 1
    assert hotel_two_leads["total"] == 1

    hotel_one_leased = await store.lease_pending_leads(hotel_one["id"], limit=1)
    hotel_two_leased = await store.lease_pending_leads(hotel_two["id"], limit=1)

    assert hotel_one_leased[0]["campaign_id"] == hotel_one["id"]
    assert hotel_two_leased[0]["campaign_id"] == hotel_two["id"]
    assert hotel_one_leased[0]["phone_number"] == hotel_two_leased[0]["phone_number"]
    assert hotel_one_leased[0]["context_override"] == "hotel_one"
    assert hotel_two_leased[0]["context_override"] == "hotel_two"


@pytest.mark.asyncio
@pytest.mark.p0
async def test_mcp_tool_injects_business_scope_when_model_omits_instance_id():
    from src.tools.context import ToolExecutionContext
    from src.tools.mcp_tool import MCPTool, MCPToolBehavior

    class FakeManager:
        def __init__(self):
            self.arguments = None

        async def call_tool(self, *, server_id, tool_name, arguments, timeout_ms):
            self.arguments = dict(arguments)
            return {"structured": {"spoken": "ok"}}

    manager = FakeManager()
    tool = MCPTool(
        exposed_name="sales_lookup",
        server_id="sales_brain",
        mcp_tool_name="resolve_customer",
        description="Resolve customer",
        input_schema={
            "type": "object",
            "properties": {
                "phone": {"type": "string"},
                "instance_id": {"type": "integer"},
            },
        },
        manager=manager,
        behavior=MCPToolBehavior(speech_field="spoken"),
    )

    await tool.execute({"phone": "+79990000001"}, ToolExecutionContext(call_id="call-1", business_id=22))

    assert manager.arguments == {"phone": "+79990000001", "instance_id": 22}


@pytest.mark.asyncio
@pytest.mark.p0
async def test_mcp_tool_overwrites_model_supplied_pms_tenant_and_caller_context():
    from src.tools.context import ToolExecutionContext
    from src.tools.mcp_tool import MCPTool, MCPToolBehavior

    class FakeManager:
        arguments = None

        async def call_tool(self, *, server_id, tool_name, arguments, timeout_ms):
            self.arguments = dict(arguments)
            return {"structured": {"spoken": "ok"}}

    manager = FakeManager()
    tool = MCPTool(
        exposed_name="pms_lookup",
        server_id="bnovo_pms",
        mcp_tool_name="lookup_booking",
        description="Lookup booking",
        input_schema={"type": "object", "properties": {
            "business_id": {"type": "integer"},
            "instance_id": {"type": "integer"},
            "call_id": {"type": "string"},
            "caller_number": {"type": "string"},
            "channel": {"type": "string"},
        }},
        manager=manager,
        behavior=MCPToolBehavior(speech_field="spoken"),
    )

    await tool.execute(
        {"business_id": 999, "instance_id": 999, "call_id": "fake", "caller_number": "+70000000000", "channel": "whatsapp"},
        ToolExecutionContext(call_id="real-call", business_id=22, caller_number="+79990000001"),
    )

    assert manager.arguments == {
        "business_id": 22,
        "instance_id": 22,
        "call_id": "real-call",
        "caller_number": "+79990000001",
        "channel": "voice",
    }


@pytest.mark.asyncio
@pytest.mark.p0
async def test_outbound_campaign_business_scope_is_inherited_and_enforced(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")

    from src.core.outbound_store import OutboundStore

    store = OutboundStore(db_path=str(tmp_path / "outbound.db"))
    hotel_one = await store.create_campaign({"name": "Hotel One", "timezone": "UTC", "default_context": "hotel_one", "business_id": 1})
    hotel_two = await store.create_campaign({"name": "Hotel Two", "timezone": "UTC", "default_context": "hotel_two", "business_id": 2})

    csv_bytes = b"phone_number,name,business_id\n+79990000001,Shared Phone,999\n"
    assert (await store.import_leads_csv(hotel_one["id"], csv_bytes))["accepted"] == 1
    assert (await store.import_leads_csv(hotel_two["id"], csv_bytes))["accepted"] == 1

    hotel_one_leads = await store.list_leads(hotel_one["id"])
    hotel_two_leads = await store.list_leads(hotel_two["id"])
    assert hotel_one_leads["leads"][0]["business_id"] == 1
    assert hotel_two_leads["leads"][0]["business_id"] == 2

    assert await store.lease_pending_leads(hotel_one["id"], limit=1, business_id=2) == []
    leased = await store.lease_pending_leads(hotel_one["id"], limit=1, business_id=1)
    assert leased[0]["business_id"] == 1

    await store.set_campaign_status(hotel_one["id"], "running")
    attempt_id = await store.create_attempt(hotel_one["id"], leased[0]["id"], business_id=1)
    attempts = await store.list_attempts(hotel_one["id"])
    assert attempts["attempts"][0]["id"] == attempt_id
    assert attempts["attempts"][0]["business_id"] == 1

    with pytest.raises(ValueError):
        await store.create_attempt(hotel_one["id"], leased[0]["id"], business_id=2)


@pytest.mark.asyncio
@pytest.mark.p0
async def test_call_history_persists_business_scope_and_called_number(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")

    from src.core.call_history import CallHistoryStore, CallRecord

    store = CallHistoryStore(db_path=str(tmp_path / "call_history.db"))
    record = CallRecord(
        call_id="call-tenant-1",
        caller_number="+79990000001",
        caller_name="Guest",
        called_number="+74951234567",
        business_id=2,
        start_time=datetime(2026, 7, 1, 10, 0, tzinfo=timezone.utc),
        end_time=datetime(2026, 7, 1, 10, 3, tzinfo=timezone.utc),
        duration_seconds=180,
        provider_name="google_live",
        context_name="hotel_two",
    )

    assert await store.save(record)
    saved = await store.get_by_call_id("call-tenant-1")

    assert saved is not None
    assert saved.called_number == "+74951234567"
    assert saved.business_id == 2


@pytest.mark.unit
@pytest.mark.p0
def test_sales_brain_sync_derives_campaign_business_scope_from_export_metadata():
    from admin_ui.backend.api.outbound import _derive_sales_brain_business_id

    export_data = {
        "campaign": {"name": "Hotel Two"},
        "leads": [
            {
                "phone_number": "+79990000001",
                "custom_vars": {
                    "sales_brain_instance_id": 2,
                    "whatsapp_chat_id": "79990000001@c.us",
                },
            }
        ],
    }

    assert _derive_sales_brain_business_id(export_data) == 2
