import pytest


class _ContractTool:
    def __init__(self, definition):
        self._definition = definition

    @property
    def definition(self):
        return self._definition

    async def execute(self, parameters, context):
        return {"status": "success"}


@pytest.mark.unit
def test_google_and_openai_realtime_adapters_share_sales_brain_tool_contract():
    from src.tools.adapters.google import GoogleToolAdapter
    from src.tools.adapters.openai import OpenAIToolAdapter
    from src.tools.base import ToolCategory, ToolDefinition
    from src.tools.registry import tool_registry

    tool_registry.clear()
    tool_registry.register_instance(
        _ContractTool(
            ToolDefinition(
                name="mcp_sales_resolve_customer",
                description="Resolve a Sales Brain customer.",
                category=ToolCategory.BUSINESS,
                input_schema={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "phone": {
                            "type": "string",
                            "description": "Customer phone.",
                            "default": "",
                        }
                    },
                    "required": ["phone"],
                },
            )
        )
    )

    try:
        openai_schema = OpenAIToolAdapter(tool_registry).get_tools_config(
            ["mcp_sales_resolve_customer"]
        )
        google_schema = GoogleToolAdapter(tool_registry).format_tools(
            ["mcp_sales_resolve_customer"]
        )
    finally:
        tool_registry.clear()

    assert openai_schema == [
        {
            "type": "function",
            "name": "mcp_sales_resolve_customer",
            "description": "Resolve a Sales Brain customer.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "phone": {
                        "type": "string",
                        "description": "Customer phone.",
                        "default": "",
                    }
                },
                "required": ["phone"],
            },
        }
    ]
    assert "function" not in openai_schema[0]

    google_declarations = google_schema[0]["functionDeclarations"]
    assert [tool["name"] for tool in google_declarations] == ["mcp_sales_resolve_customer"]
    google_params = google_declarations[0]["parameters"]
    assert "additionalProperties" not in google_params
    assert "default" not in google_params["properties"]["phone"]
