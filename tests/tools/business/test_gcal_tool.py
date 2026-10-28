"""
Tests for Google Calendar Tool (GCalendarTool).

Covers definition, config handling, and execution for list_events, get_event,
create_event, delete_event, and get_free_slots actions.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock

from src.tools.business.gcal_tool import GCalendarTool
from src.tools.base import ToolCategory


class TestGCalendarToolDefinition:
    """Test tool definition and schema."""

    def test_definition_name_and_category(self):
        """Tool name and category match project convention."""
        tool = GCalendarTool()
        definition = tool.definition
        assert definition.name == "google_calendar"
        assert definition.category == ToolCategory.BUSINESS

    def test_definition_uses_input_schema(self):
        """Tool uses input_schema for provider-agnostic schema (Google Live, OpenAI)."""
        tool = GCalendarTool()
        definition = tool.definition
        assert definition.input_schema is not None
        assert definition.input_schema.get("type") == "object"
        assert "properties" in definition.input_schema
        assert "action" in definition.input_schema["properties"]

    def test_definition_action_enum_includes_all_actions(self):
        """Action enum includes list_events, get_event, create_event, delete_event, get_free_slots."""
        tool = GCalendarTool()
        definition = tool.definition
        actions = definition.input_schema["properties"]["action"]["enum"]
        assert "list_events" in actions
        assert "get_event" in actions
        assert "create_event" in actions
        assert "delete_event" in actions
        assert "get_free_slots" in actions

    def test_definition_required_includes_action(self):
        """Schema required array includes action."""
        tool = GCalendarTool()
        definition = tool.definition
        assert "action" in definition.input_schema.get("required", [])


class TestGCalendarToolExecution:
    """Test execute() behavior: disabled config, missing params, delete_event flow."""

    @pytest.fixture
    def gcal_tool(self):
        return GCalendarTool()

    @pytest.fixture
    def gcal_enabled_context(self, tool_context):
        """Context with google_calendar enabled."""
        tool_context.get_config_value = Mock(
            return_value={
                "enabled": True,
                "credentials_path": "/fake/creds.json",
                "calendar_id": "primary",
            }
        )
        return tool_context

    @pytest.mark.asyncio
    async def test_disabled_returns_error(self, gcal_tool, tool_context):
        """When tool is disabled by config, returns error status."""
        tool_context.get_config_value = Mock(
            return_value={"enabled": False}
        )
        result = await gcal_tool.execute(
            parameters={"action": "list_events", "time_min": "2025-01-01T00:00:00", "time_max": "2025-01-02T00:00:00"},
            context=tool_context,
        )
        assert result["status"] == "error"
        assert "disabled" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_missing_action_returns_error(self, gcal_tool, gcal_enabled_context):
        """Missing action parameter returns error."""
        result = await gcal_tool.execute(
            parameters={},
            context=gcal_enabled_context,
        )
        assert result["status"] == "error"
        assert "action" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_delete_event_missing_event_id_returns_error(
        self, gcal_tool, gcal_enabled_context
    ):
        """delete_event without event_id returns error."""
        with patch.object(
            gcal_tool, "_get_cal", return_value=MagicMock(service=MagicMock())
        ):
            result = await gcal_tool.execute(
                parameters={"action": "delete_event"},
                context=gcal_enabled_context,
            )
        assert result["status"] == "error"
        assert "event_id" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_delete_event_success(
        self, gcal_tool, gcal_enabled_context
    ):
        """delete_event with valid event_id returns success when calendar deletes."""
        mock_cal = MagicMock()
        mock_cal.delete_event = Mock(return_value=True)
        with patch.object(gcal_tool, "_get_cal", return_value=mock_cal):
            result = await gcal_tool.execute(
                parameters={"action": "delete_event", "event_id": "evt_123"},
                context=gcal_enabled_context,
            )
        assert result["status"] == "success"
        assert result.get("id") == "evt_123"
        assert "deleted" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_delete_event_failure_returns_error(
        self, gcal_tool, gcal_enabled_context
    ):
        """delete_event when calendar returns False returns error."""
        mock_cal = MagicMock()
        mock_cal.delete_event = Mock(return_value=False)
        with patch.object(gcal_tool, "_get_cal", return_value=mock_cal):
            result = await gcal_tool.execute(
                parameters={"action": "delete_event", "event_id": "evt_unknown"},
                context=gcal_enabled_context,
            )
        assert result["status"] == "error"
        assert "delete" in result["message"].lower()
