from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

import structlog

from src.tools.base import Tool, ToolCategory, ToolDefinition
from src.tools.context import ToolExecutionContext

logger = structlog.get_logger(__name__)


def _pick_field(data: Any, dotted: str) -> Optional[Any]:
    if data is None:
        return None
    if not dotted:
        return None
    cur: Any = data
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _render_template(template: str, data: Dict[str, Any]) -> str:
    # Simple and safe-ish: only allow `{key}` placeholders where key is a top-level field.
    # Missing keys become empty strings.
    if not template:
        return ""
    out = template
    for key, value in (data or {}).items():
        out = out.replace("{" + str(key) + "}", str(value))
    # Clear any unreplaced placeholders
    import re

    out = re.sub(r"\{[a-zA-Z0-9_.-]+\}", "", out)
    return " ".join(out.split()).strip()


@dataclass(frozen=True)
class MCPToolBehavior:
    speech_field: Optional[str] = None
    speech_template: Optional[str] = None
    timeout_ms: Optional[int] = None
    slow_response_threshold_ms: Optional[int] = None
    slow_response_message: Optional[str] = None


class MCPTool(Tool):
    """Tool wrapper that routes execution to an MCP server."""

    def __init__(
        self,
        *,
        exposed_name: str,
        server_id: str,
        mcp_tool_name: str,
        description: str,
        input_schema: Optional[Dict[str, Any]],
        manager: Any,
        behavior: MCPToolBehavior,
    ):
        super().__init__()
        self._exposed_name = exposed_name
        self._server_id = server_id
        self._mcp_tool_name = mcp_tool_name
        self._description = description
        self._input_schema = input_schema
        self._manager = manager
        self._behavior = behavior

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name=self._exposed_name,
            description=self._description or f"MCP tool '{self._mcp_tool_name}' from server '{self._server_id}'.",
            category=ToolCategory.BUSINESS,
            requires_channel=False,
            max_execution_time=max(1, int((self._behavior.timeout_ms or 10000) / 1000)),
            parameters=[],
            input_schema=self._input_schema,
        )

    @property
    def slow_response_threshold_ms(self) -> int:
        return int(self._behavior.slow_response_threshold_ms or 0)

    @property
    def slow_response_message(self) -> str:
        return self._behavior.slow_response_message or ""

    async def execute(self, parameters: Dict[str, Any], context: ToolExecutionContext) -> Dict[str, Any]:
        call_id = getattr(context, "call_id", None)
        logger.info(
            "Executing MCP tool",
            call_id=call_id,
            server=self._server_id,
            tool=self._mcp_tool_name,
            exposed=self._exposed_name,
        )

        timeout_ms = self._behavior.timeout_ms
        arguments = dict(parameters or {})
        props = (self._input_schema or {}).get("properties") or {}
        business_id = int(getattr(context, "business_id", 1) or 1)
        if business_id < 1 and any(field in props for field in ("business_id", "businessId", "instance_id", "instanceId")):
            raise ValueError("Tenant scope is unavailable for this MCP tool call")
        # Reserved execution fields are authoritative. A model-provided value
        # can never survive an invalid context or move an operation to another
        # tenant/customer.
        for field in ("business_id", "businessId", "instance_id", "instanceId"):
            if field in props:
                arguments[field] = business_id
        reserved = {
            "call_id": getattr(context, "call_id", None),
            "callId": getattr(context, "call_id", None),
            "caller_number": getattr(context, "caller_number", None),
            "callerNumber": getattr(context, "caller_number", None),
            "channel": "voice",
        }
        for field, value in reserved.items():
            if field in props:
                arguments[field] = value

        # Sales Brain voice tools operate on the actual caller, including legacy
        # schemas that still expose `phone`. Model text cannot select a different customer.
        if self._exposed_name.startswith('mcp_sales_') and 'phone' in props:
            arguments['phone'] = getattr(context, 'caller_number', None)

        result = await self._manager.call_tool(
            server_id=self._server_id,
            tool_name=self._mcp_tool_name,
            arguments=arguments,
            timeout_ms=timeout_ms,
        )

        message = self._build_speech_message(result)
        if self._exposed_name in {"mcp_sales_draft_followup", "mcp_sales_draft_whatsapp_followup", "mcp_sales_send_followup", "mcp_sales_send_whatsapp_followup"}:
            structured = result.get("structured", {}) if isinstance(result, dict) else {}
            if isinstance(structured, dict):
                return {"status": structured.get("status", "unknown"), "message": message,
                        "data": {key: structured[key] for key in ("sent", "draft_id", "requires_approval", "error") if key in structured}}
        return {
            "status": "success",
            "message": message,
            # Keep structured data for follow-up reasoning/tool chaining, but avoid adding
            # extra metadata fields into provider tool responses (log routing metadata instead).
            "result": result,
        }

    def _build_speech_message(self, result: Dict[str, Any]) -> str:
        # If MCP server returns content blocks with text, prefer that as a fallback.
        content_text = ""
        try:
            content = result.get("content", [])
            if isinstance(content, list):
                parts = []
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                        parts.append(str(item["text"]))
                content_text = " ".join(parts).strip()
        except Exception:
            content_text = ""

        # Allow server-side structured payloads. Many servers include a "data" field or similar.
        data_obj: Dict[str, Any] = {}
        if isinstance(result, dict):
            # Some servers return {"content":[...], "structured":{...}}
            for key in ("structured", "data", "result", "output"):
                if isinstance(result.get(key), dict):
                    data_obj = result[key]
                    break
            if not data_obj:
                # Use top-level fields as a last resort
                data_obj = {k: v for k, v in result.items() if k not in ("content",)}

        if self._behavior.speech_template:
            rendered = _render_template(self._behavior.speech_template, data_obj)
            if rendered:
                return rendered

        if self._behavior.speech_field:
            picked = _pick_field(data_obj, self._behavior.speech_field)
            if picked is not None:
                return str(picked).strip()

        if content_text:
            return content_text

        return "I have the result."
