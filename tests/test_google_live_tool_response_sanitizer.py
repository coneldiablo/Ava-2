import pytest


@pytest.mark.unit
def test_google_live_tool_response_payload_drops_large_fields():
    from src.providers.google_live import GoogleLiveProvider
    from src.config import GoogleProviderConfig

    provider = GoogleLiveProvider(config=GoogleProviderConfig(), on_event=lambda e: None)

    huge = {"nested": {"x": "y" * 20000}}
    result = {
        "status": "success",
        "message": "ok",
        "data": huge,
        "mcp": {"server": "s", "tool": "t"},
    }
    payload = provider._build_tool_response_payload("mcp_tool", result)
    assert "data" not in payload
    assert "mcp" not in payload
    assert payload["status"] == "success"


@pytest.mark.unit
def test_google_live_tool_response_payload_keeps_short_output_and_error():
    from src.providers.google_live import GoogleLiveProvider
    from src.config import GoogleProviderConfig

    provider = GoogleLiveProvider(config=GoogleProviderConfig(), on_event=lambda e: None)

    payload = provider._build_tool_response_payload(
        "mcp_tool",
        {
            "status": "error",
            "message": "Lookup failed safely",
            "output": {"retryable": True},
            "error": "timeout",
            "result": {"raw": "x" * 20000},
        },
    )

    assert payload["status"] == "error"
    assert payload["message"] == "Lookup failed safely"
    assert payload["output"] == {"retryable": True}
    assert payload["error"] == "timeout"
    assert "result" not in payload


@pytest.mark.unit
def test_google_tool_schema_sanitizer_strips_mcp_json_schema_keywords():
    from src.tools.adapters.google import _sanitize_google_schema

    sanitized = _sanitize_google_schema(
        {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "guest": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"name": {"type": "string", "default": "Guest"}},
                }
            },
            "$schema": "https://json-schema.org/draft/2020-12/schema",
        }
    )

    assert "additionalProperties" not in sanitized
    assert "$schema" not in sanitized
    assert "additionalProperties" not in sanitized["properties"]["guest"]
    assert "default" not in sanitized["properties"]["guest"]["properties"]["name"]


@pytest.mark.asyncio
@pytest.mark.unit
async def test_google_live_setup_includes_context_tools_and_native_search(monkeypatch):
    from src.providers.google_live import GoogleLiveProvider
    from src.config import GoogleProviderConfig

    provider = GoogleLiveProvider(config=GoogleProviderConfig(), on_event=lambda e: None)
    sent = []

    async def fake_send_message(payload):
        sent.append(payload)

    monkeypatch.setattr(provider, "_send_message", fake_send_message)
    monkeypatch.setattr(
        provider._tool_adapter,
        "format_tools",
        lambda tool_names: [
            {
                "functionDeclarations": [
                    {
                        "name": tool_names[0],
                        "description": "Demo tool",
                        "parameters": {"type": "object", "properties": {}},
                    }
                ]
            }
        ],
    )

    await provider._send_setup(
        {
            "tools": ["mcp_weather_get_city"],
            "google_builtin_tools": {"google_search": True},
        }
    )

    setup_tools = sent[0]["setup"]["tools"]
    assert setup_tools[0]["functionDeclarations"][0]["name"] == "mcp_weather_get_city"
    assert setup_tools[1] == {"googleSearch": {}}


@pytest.mark.asyncio
@pytest.mark.unit
async def test_google_live_setup_without_tools_does_not_expose_global_tools(monkeypatch):
    from src.providers.google_live import GoogleLiveProvider
    from src.config import GoogleProviderConfig

    provider = GoogleLiveProvider(config=GoogleProviderConfig(), on_event=lambda e: None)
    sent = []

    async def fake_send_message(payload):
        sent.append(payload)

    def fail_global_tools(_tool_names):
        raise AssertionError("No global Google Live tools should be exposed without context allowlist")

    monkeypatch.setattr(provider, "_send_message", fake_send_message)
    monkeypatch.setattr(provider._tool_adapter, "format_tools", fail_global_tools)

    await provider._send_setup({"tools": []})

    assert "tools" not in sent[0]["setup"]
