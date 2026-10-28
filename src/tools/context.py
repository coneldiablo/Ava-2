"""
Tool execution context - provides access to system resources during tool execution.

Includes:
- ToolExecutionContext: For in-call tool execution (existing)
- PreCallContext: For pre-call tools (CRM lookup, enrichment)
- PostCallContext: For post-call tools (webhooks, CRM updates)
"""

from dataclasses import dataclass, field
from typing import Optional, Any, Dict, List
import logging

logger = logging.getLogger(__name__)


@dataclass
class ToolExecutionContext:
    """
    Context provided to tools during execution.
    
    Contains all information and system access needed for a tool to execute,
    including call metadata, session state, and system clients (ARI, etc.).
    """
    
    # Call information
    call_id: str
    caller_channel_id: Optional[str] = None
    bridge_id: Optional[str] = None
    caller_number: Optional[str] = None   # CALLERID(num) - caller's phone number
    called_number: Optional[str] = None   # DIALED_NUMBER or __FROM_DID - the number that was dialed
    caller_name: Optional[str] = None     # CALLERID(name) for personalization
    context_name: Optional[str] = None    # AI_CONTEXT from dialplan
    business_id: int = 1                  # Tenant scope; equals WhatsApp CRM instanceId for v1
    autopilot_allowed_actions: Optional[List[str]] = None
    
    # System access (injected by provider)
    session_store: Any = None  # SessionStore instance
    ari_client: Any = None      # ARIClient instance
    config: Any = None           # Config dict
    
    # Provider information
    provider_name: str = None  # "deepgram", "openai_realtime", "custom_pipeline"
    provider_session: Any = None
    runtime_guard: Any = None  # Optional fresh business/conversation permission check.
    
    # Request metadata
    user_input: Optional[str] = None  # Original user utterance
    detected_intent: Optional[str] = None
    confidence: Optional[float] = None

    @staticmethod
    def is_pending_attended_transfer(session: Any) -> bool:
        """Return True when an attended transfer is awaiting a callee decision."""
        current_action = getattr(session, "current_action", None) or {}
        if not isinstance(current_action, dict):
            return False

        if current_action.get("type") != "attended_transfer":
            return False

        decision = str(current_action.get("decision") or "").strip().lower()
        return decision not in {"accepted", "declined"}
    
    async def get_session(self):
        """
        Get current call session from session store.
        
        Returns:
            Session object with call state
        
        Raises:
            RuntimeError: If session not found
        """
        if not self.session_store:
            raise RuntimeError("SessionStore not available in context")
        
        session = await self.session_store.get_by_call_id(self.call_id)
        if not session:
            raise RuntimeError(f"Session not found for call_id: {self.call_id}")
        
        return session
    
    async def update_session(self, **kwargs):
        """
        Update call session with new attributes.
        
        Args:
            **kwargs: Attributes to update on session
        
        Example:
            await context.update_session(
                transfer_active=True,
                transfer_target="2765"
            )
        """
        if not self.session_store:
            raise RuntimeError("SessionStore not available in context")
        
        session = await self.get_session()
        
        for key, value in kwargs.items():
            setattr(session, key, value)
        
        await self.session_store.upsert_call(session)
        logger.debug(f"Updated session {self.call_id}: {kwargs}")

    async def get_tool_block_response(self, tool_name: Optional[str]) -> Optional[Dict[str, Any]]:
        """
        Return a standardized error result when a pending attended transfer should
        block tool execution for the active call.
        """
        if self.runtime_guard is not None:
            try:
                blocked = await self.runtime_guard(self.call_id, tool_name)
            except Exception:
                # A configured guard failing is never permission to perform a write.
                blocked = {"status": "error", "code": "voice_autopilot_gate_unavailable", "message": "Conversation permission could not be checked.", "ai_should_speak": False}
            if blocked:
                return blocked

        if tool_name == "cancel_transfer":
            return None

        try:
            session = await self.get_session()
        except Exception:
            logger.debug(
                "Unable to load session while checking pending attended transfer guard for call_id=%s tool=%s",
                self.call_id,
                tool_name,
                exc_info=True,
            )
            return self._autopilot_tool_block_response(tool_name)

        if not self.is_pending_attended_transfer(session):
            tool_policy_block = self._autopilot_tool_block_response(tool_name)
            if tool_policy_block:
                return tool_policy_block
            return None

        logger.warning(
            "Blocking tool call during pending attended transfer for call_id=%s tool=%s provider=%s",
            self.call_id,
            tool_name,
            self.provider_name,
        )
        return {
            "status": "error",
            "message": "Tool calls are blocked while an attended transfer is pending. Wait for the transfer to complete or use cancel_transfer.",
        }

    def _autopilot_tool_block_response(self, tool_name: Optional[str]) -> Optional[Dict[str, Any]]:
        allowed = {str(item or "").strip() for item in (self.autopilot_allowed_actions or []) if str(item or "").strip()}
        if not allowed:
            return None
        required = self._autopilot_required_action_for_tool(tool_name)
        if not required or required in allowed:
            return None
        logger.warning(
            "Blocking tool call by sales autopilot policy for call_id=%s tool=%s required_action=%s provider=%s",
            self.call_id,
            tool_name,
            required,
            self.provider_name,
        )
        return {
            "status": "error",
            "message": f"Tool '{tool_name}' is not allowed by the published sales autopilot policy.",
            "required_action": required,
        }

    @staticmethod
    def _autopilot_required_action_for_tool(tool_name: Optional[str]) -> Optional[str]:
        name = str(tool_name or "").strip().lower()
        if not name:
            return None
        if name in {"hangup_call", "cancel_transfer"}:
            return None
        if name in {"transfer", "transfer_call", "blind_transfer", "live_agent_transfer", "transfer_to_live_agent", "mcp_sales_create_manager_task"}:
            return None
        if "handoff" in name or name.startswith("mcp_hotel_handoff"):
            return "handoff"
        if name in {"mcp_sales_create_crm_note", "mcp_sales_update_stage", "mcp_sales_draft_whatsapp_followup", "mcp_sales_draft_followup"}:
            return "update_fields"
        if "update" in name or "crm_note" in name or "draft_whatsapp" in name:
            return "update_fields"
        if "quote" in name or "proposal" in name:
            return "quote"
        if name in {"mcp_sales_send_whatsapp_followup", "mcp_sales_send_followup"} or "send_whatsapp" in name:
            return "reply"
        if name.startswith("mcp_sales_"):
            return "reply"
        return None
    
    def get_config_value(self, key: str, default: Any = None) -> Any:
        """
        Get configuration value.
        
        Args:
            key: Config key (supports dot notation, e.g., "tools.transfer.destinations.support_agent.target")
            default: Default value if key not found
        
        Returns:
            Config value or default
        """
        if not self.config:
            return default
        
        # Support dot notation for nested keys
        keys = key.split('.')
        value = self.config
        
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        
        return value


@dataclass
class PreCallContext:
    """
    Context provided to pre-call tools.
    
    Pre-call tools run after the call is answered but before the AI speaks.
    They fetch enrichment data (e.g., CRM lookup) to inject into prompts.
    """
    
    # Call identifiers
    call_id: str
    caller_number: str  # ANI (caller's phone number)
    called_number: Optional[str] = None  # DID that was called
    caller_name: Optional[str] = None  # Caller ID name if available
    
    # Context information
    context_name: str = ""  # AI_CONTEXT from dialplan
    business_id: int = 1  # Tenant scope; equals WhatsApp CRM instanceId for v1
    call_direction: str = "inbound"  # "inbound" or "outbound"
    
    # Outbound-specific (from campaign dialer)
    campaign_id: Optional[str] = None
    lead_id: Optional[str] = None
    outbound_custom_vars: Dict[str, Any] = field(default_factory=dict)
    
    # Channel variables from Asterisk
    channel_vars: Dict[str, str] = field(default_factory=dict)
    
    # System access
    config: Any = None  # Config dict
    ari_client: Any = None  # ARIClient instance (for hold audio playback)
    
    def get_config_value(self, key: str, default: Any = None) -> Any:
        """Get configuration value with dot notation support."""
        if not self.config:
            return default
        
        keys = key.split('.')
        value = self.config
        
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        
        return value


@dataclass
class PostCallContext:
    """
    Context provided to post-call tools.
    
    Post-call tools run after the call ends (fire-and-forget).
    They receive comprehensive session data for webhooks, CRM updates, etc.
    """
    
    # Call identifiers
    call_id: str
    caller_number: str  # ANI
    called_number: Optional[str] = None  # DID
    caller_name: Optional[str] = None
    phone_number_id: Optional[str] = None
    recording_file: Optional[str] = None  # Managed basename; readiness requires the recording API.
    
    # Context and provider
    context_name: str = ""
    business_id: int = 1  # Tenant scope; equals WhatsApp CRM instanceId for v1
    provider: str = ""  # Provider used for the call
    call_direction: str = "inbound"
    
    # Call metrics
    call_duration_seconds: int = 0
    call_outcome: str = ""  # e.g., "answered_human", "voicemail", "no_answer"
    call_start_time: Optional[str] = None  # ISO timestamp
    call_end_time: Optional[str] = None  # ISO timestamp
    
    # Conversation data
    conversation_history: List[Dict[str, str]] = field(default_factory=list)  # Transcript
    summary: Optional[str] = None  # AI-generated summary if available
    
    # Tool execution data
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)  # In-call tool executions
    pre_call_results: Dict[str, str] = field(default_factory=dict)  # Data from pre-call tools

    # Manager handoff evidence (e.g. a transfer to a human that never landed)
    handoff_signals: List[Dict[str, Any]] = field(default_factory=list)
    
    # Outbound-specific
    campaign_id: Optional[str] = None
    lead_id: Optional[str] = None
    outbound_custom_vars: Dict[str, Any] = field(default_factory=dict)
    
    # System access
    config: Any = None
    
    def to_payload_dict(self) -> Dict[str, Any]:
        """
        Convert context to a dictionary suitable for webhook payloads.
        
        Returns:
            Dictionary with all call data for templating.
        """
        import json
        return {
            "call_id": self.call_id,
            "caller_number": self.caller_number,
            "called_number": self.called_number or "",
            "phone_number_id": self.phone_number_id or "",
            "recording_file": self.recording_file or "",
            "caller_name": self.caller_name or "",
            "context_name": self.context_name,
            "business_id": self.business_id,
            "provider": self.provider,
            "call_direction": self.call_direction,
            "call_duration": self.call_duration_seconds,
            "call_outcome": self.call_outcome,
            "call_start_time": self.call_start_time or "",
            "call_end_time": self.call_end_time or "",
            "transcript_json": json.dumps(self.conversation_history),
            "summary": self.summary or "",
            "tool_calls_json": json.dumps(self.tool_calls),
            "pre_call_results_json": json.dumps(self.pre_call_results),
            "handoff_signals_json": json.dumps(self.handoff_signals),
            "campaign_id": self.campaign_id or "",
            "lead_id": self.lead_id or "",
            "outbound_custom_vars_json": json.dumps(self.outbound_custom_vars),
        }
