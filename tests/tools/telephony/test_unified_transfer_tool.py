"""
Unit tests for UnifiedTransferTool destination resolution.
"""

import pytest

from src.tools.telephony.unified_transfer import UnifiedTransferTool


class TestUnifiedTransferTool:
    @pytest.fixture
    def tool(self):
        return UnifiedTransferTool()

    def test_definition_uses_generic_destination_language(self, tool):
        definition = tool.definition
        assert definition.name == "blind_transfer"
        assert "support_agent" not in definition.description
        assert "sales_agent" not in definition.description

    @pytest.mark.asyncio
    async def test_resolves_destination_by_description_match(self, tool, tool_context, mock_ari_client):
        tool_context.config["tools"]["transfer"] = {
            "destinations": {
                "tier2_desk": {
                    "type": "extension",
                    "target": "6000",
                    "description": "Support Team",
                }
            }
        }

        result = await tool.execute({"destination": "support"}, tool_context)

        assert result["status"] == "success"
        assert result["type"] == "extension"
        assert result["destination"] == "6000"

        call_args = mock_ari_client.send_command.call_args.kwargs
        assert call_args["resource"] == f"channels/{tool_context.caller_channel_id}/continue"
        assert call_args["params"]["extension"] == "6000"

    @pytest.mark.asyncio
    async def test_human_intent_maps_to_single_extension_destination(self, tool, tool_context):
        tool_context.config["tools"]["transfer"] = {
            "destinations": {
                "frontdesk": {
                    "type": "extension",
                    "target": "6010",
                    "description": "Reception Desk",
                },
                "support_queue": {
                    "type": "queue",
                    "target": "500",
                    "description": "Support Queue",
                },
            }
        }

        result = await tool.execute({"destination": "live person"}, tool_context)

        assert result["status"] == "success"
        assert result["type"] == "extension"
        assert result["destination"] == "6010"

    @pytest.mark.asyncio
    async def test_resolves_destination_by_exact_target_number(self, tool, tool_context, mock_ari_client):
        tool_context.config["tools"]["transfer"] = {
            "destinations": {
                "support_agent": {
                    "type": "extension",
                    "target": "6000",
                    "description": "Support Agent",
                }
            }
        }

        result = await tool.execute({"destination": "6000"}, tool_context)

        assert result["status"] == "success"
        assert result["type"] == "extension"
        assert result["destination"] == "6000"

        call_args = mock_ari_client.send_command.call_args.kwargs
        assert call_args["resource"] == f"channels/{tool_context.caller_channel_id}/continue"
        assert call_args["params"]["extension"] == "6000"

    @pytest.mark.asyncio
    async def test_human_intent_without_extension_destination_fails(self, tool, tool_context):
        tool_context.config["tools"]["transfer"] = {
            "destinations": {
                "ops_queue": {
                    "type": "queue",
                    "target": "700",
                    "description": "Operations Queue",
                }
            }
        }

        result = await tool.execute({"destination": "live agent"}, tool_context)

        assert result["status"] == "failed"
        assert "Unknown destination" in result["message"]
