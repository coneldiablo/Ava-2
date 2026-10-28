import subprocess
import sys
from pathlib import Path

import yaml

from src.mcp_servers import bnovo_pms_mcp_server as server
from src.mcp.stdio_framing import decode_frame, encode_message


def test_bnovo_pms_tools_expose_reserved_execution_scope():
    tools = server._tools()["tools"]
    assert {tool["name"] for tool in tools} == {
        "lookup_booking",
        "check_room_availability",
        "get_booking_services",
        "create_booking_request",
    }
    for tool in tools:
        props = tool["inputSchema"]["properties"]
        assert "business_id" in props
        assert "call_id" in props
        assert "caller_number" in props
        assert "channel" in props


def test_bnovo_lookup_returns_only_voice_safe_summary(monkeypatch):
    def fake_post(path, payload):
        assert path == "/api/ml/pms/lookup-booking"
        assert payload["business_id"] == 7
        return {
            "success": True,
            "bookings": [{
                "booking_number": "AB-42",
                "arrival": "2026-09-01",
                "departure": "2026-09-03",
                "status": "Новое",
                "email": "must-not-be-spoken@example.test",
                "room_number": "301",
            }],
        }

    monkeypatch.setattr(server, "_post", fake_post)
    result = server._call("lookup_booking", {"business_id": 7, "caller_number": "+79990000001"})
    spoken = result["structured"]["spoken"]
    assert "AB-42" in spoken
    assert "must-not-be-spoken" not in spoken
    assert "301" not in spoken


def test_bnovo_outage_never_confirms_availability(monkeypatch):
    def fail(*_args, **_kwargs):
        raise TimeoutError("Authorization: Bearer secret")

    monkeypatch.setattr(server, "_post", fail)
    result = server._call("check_room_availability", {
        "business_id": 7,
        "date_from": "2026-09-01",
        "date_to": "2026-09-03",
    })
    assert result["structured"]["status"] == "error"
    assert "не могу подтвердить" in result["structured"]["spoken"]
    assert result["structured"]["manager_task_created"] is False
    assert result["structured"]["requires_manager"] is False
    assert result["structured"]["can_continue"] is True
    assert "secret" not in str(result)


def test_bnovo_mcp_stdio_server_initializes_and_lists_tools():
    request = encode_message({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {},
    }) + encode_message({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {},
    })
    process = subprocess.run(
        [sys.executable, "-m", "src.mcp_servers.bnovo_pms_mcp_server"],
        input=request,
        capture_output=True,
        check=True,
        timeout=5,
    )

    buffer = bytearray(process.stdout)
    initialize, consumed = decode_frame(buffer)
    del buffer[:consumed]
    tools, consumed = decode_frame(buffer)

    assert initialize["result"]["serverInfo"]["name"] == "bnovo_pms"
    assert {tool["name"] for tool in tools["result"]["tools"]} == {
        "lookup_booking",
        "check_room_availability",
        "get_booking_services",
        "create_booking_request",
    }
    assert consumed == len(buffer)


def test_demo_pms_aliases_do_not_shadow_bnovo_tools():
    config = yaml.safe_load(Path("config/ai-agent.yaml").read_text(encoding="utf-8"))
    servers = config["mcp"]["servers"]
    bnovo = {tool["name"]: tool["expose_as"] for tool in servers["bnovo_pms"]["tools"]}
    demo = {tool["name"]: tool["expose_as"] for tool in servers["hotel_demo"]["tools"]}

    assert bnovo["lookup_booking"] == "mcp_hotel_lookup_booking"
    assert bnovo["check_room_availability"] == "mcp_hotel_check_availability"
    assert bnovo["create_booking_request"] == "mcp_hotel_create_booking_request"
    assert demo["lookup_booking"] == "mcp_hotel_demo_lookup_booking"
    assert demo["check_room_availability"] == "mcp_hotel_demo_check_availability"
    assert demo["create_booking_request"] == "mcp_hotel_demo_create_booking_request"
    assert set(bnovo.values()).isdisjoint({
        demo["lookup_booking"],
        demo["check_room_availability"],
        demo["create_booking_request"],
    })
