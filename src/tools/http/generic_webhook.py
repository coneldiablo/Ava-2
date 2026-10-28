"""Generic webhook tool for post-call delivery."""

import os
import re
import json
import logging
from typing import Dict, Any, Optional
from dataclasses import dataclass, field

import aiohttp

from src.tools.base import PostCallTool, ToolDefinition, ToolCategory, ToolPhase
from src.tools.context import PostCallContext

logger = logging.getLogger(__name__)

try:
    import openai  # type: ignore
except ImportError:  # pragma: no cover
    openai = None


@dataclass
class WebhookConfig:
    """Configuration for a generic webhook tool instance."""
    name: str
    enabled: bool = True
    phase: str = "post_call"
    is_global: bool = False
    timeout_ms: int = 5000
    
    # HTTP request configuration
    url: str = ""
    method: str = "POST"
    headers: Dict[str, str] = field(default_factory=dict)
    
    # Payload template (JSON string with variable substitution)
    payload_template: Optional[str] = None
    
    # Default content type
    content_type: str = "application/json"
    require_ack: bool = False
    
    # Summary generation (optional - uses LLM to summarize transcript)
    generate_summary: bool = False
    summary_max_words: int = 100
    summary_provider: str = "google"
    summary_model: Optional[str] = None


class GenericWebhookTool(PostCallTool):
    """
    Generic webhook tool for post-call notifications.
    
    Configured via YAML, sends call data to external endpoints
    after the call ends. The engine retries failed deliveries.
    
    Example config:
    ```yaml
    tools:
      n8n_webhook:
        kind: generic_webhook
        phase: post_call
        enabled: true
        is_global: true
        timeout_ms: 5000
        url: "https://n8n.example.com/webhook/call-completed"
        method: POST
        headers:
          Content-Type: "application/json"
          Authorization: "Bearer ${N8N_API_KEY}"
        payload_template: |
          {
            "schema_version": 1,
            "event_type": "call_completed",
            "call_id": "{call_id}",
            "caller_number": "{caller_number}",
            "caller_name": "{caller_name}",
            "call_duration": {call_duration},
            "call_outcome": "{call_outcome}",
            "transcript": {transcript_json},
            "summary": "{summary}",
            "context": "{context_name}",
            "provider": "{provider}",
            "timestamp": "{call_end_time}"
          }
    ```
    """
    
    def __init__(self, config: WebhookConfig):
        self.config = config
        self._definition = ToolDefinition(
            name=config.name,
            description=f"Webhook: {config.name}",
            category=ToolCategory.BUSINESS,
            phase=ToolPhase.POST_CALL,
            is_global=config.is_global,
            timeout_ms=config.timeout_ms,
        )
    
    @property
    def definition(self) -> ToolDefinition:
        return self._definition
    
    async def execute(self, context: PostCallContext) -> None:
        """
        Execute the webhook and fail if the receiver did not confirm delivery.
        
        Args:
            context: PostCallContext with comprehensive call data
        """
        if not self.config.enabled:
            raise RuntimeError("post-call webhook is disabled")
        
        if not self.config.url:
            raise RuntimeError("post-call webhook has no URL")
        
        try:
            # Generate summary if requested and not already present
            if self.config.generate_summary and not context.summary:
                context.summary = await self._generate_summary(context)
            
            # Build request
            url = self._substitute_variables(self.config.url, context)
            headers = {
                k: self._substitute_variables(v, context)
                for k, v in self.config.headers.items()
            }
            
            # Ensure content-type is set
            if 'Content-Type' not in headers and 'content-type' not in headers:
                headers['Content-Type'] = self.config.content_type
            
            # Build payload
            payload = None
            if self.config.payload_template:
                payload = self._build_payload(context)
            else:
                # Default payload using context's to_payload_dict
                payload = json.dumps(context.to_payload_dict())

            logger.info(f"Sending webhook: {self.config.name} {self.config.method} {self._redact_url(url)}")
            
            # Make request and require a confirmed response.
            timeout = aiohttp.ClientTimeout(total=self.config.timeout_ms / 1000.0)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.request(
                    method=self.config.method,
                    url=url,
                    headers=headers,
                    data=payload,
                ) as response:
                    status = response.status
                    if 200 <= status < 300:
                        if self.config.require_ack:
                            try:
                                acknowledgement = await response.json()
                            except Exception as exc:
                                raise RuntimeError("post-call webhook acknowledgement is invalid") from exc
                            if acknowledgement.get("success") is not True:
                                raise RuntimeError("post-call webhook did not confirm durable save")
                        logger.info(f"Webhook sent successfully: {self.config.name} status={status}")
                    else:
                        raise RuntimeError(f"post-call webhook returned HTTP {status}")
        
        except Exception:
            # The durable delivery worker records the retry state. Do not log
            # response bodies, request headers, or the transcript here.
            raise
    
    def _build_payload(self, context: PostCallContext) -> str:
        """
        Build payload from template with variable substitution.
        """
        template = self.config.payload_template or "{}"
        
        # Get payload dict from context
        payload_vars = context.to_payload_dict()
        
        # Add schema_version
        payload_vars["schema_version"] = "1"
        
        # Add summary_json as separate variable (keeps transcript_json intact)
        if context.summary:
            payload_vars["summary_json"] = json.dumps(context.summary)
        else:
            payload_vars["summary_json"] = json.dumps("")
        
        # Substitute variables
        result = template
        
        # Simple variable substitution: {var_name}
        for key, value in payload_vars.items():
            placeholder = "{" + key + "}"
            if placeholder in result:
                # For JSON fields (ending with _json), don't quote
                if key.endswith("_json"):
                    result = result.replace(placeholder, str(value))
                else:
                    # Escape for JSON string
                    escaped = json.dumps(str(value))[1:-1]  # Remove outer quotes
                    result = result.replace(placeholder, escaped)
        
        # Environment variables: ${VAR_NAME}
        env_pattern = r'\$\{([A-Z_][A-Z0-9_]*)\}'
        def env_replacer(match):
            var_name = match.group(1)
            value = os.environ.get(var_name, "")
            return json.dumps(value)[1:-1]  # Escape for JSON
        
        result = re.sub(env_pattern, env_replacer, result)
        
        return result
    
    def _substitute_variables(self, template: str, context: PostCallContext) -> str:
        """
        Substitute variables in URL/headers.
        """
        result = template
        
        # Context variables
        replacements = {
            "{call_id}": context.call_id or "",
            "{caller_number}": context.caller_number or "",
            "{called_number}": context.called_number or "",
            "{caller_name}": context.caller_name or "",
            "{context_name}": context.context_name or "",
            "{business_id}": str(int(getattr(context, "business_id", 1) or 1)),
            "{provider}": context.provider or "",
            "{call_direction}": context.call_direction or "",
            "{campaign_id}": context.campaign_id or "",
            "{lead_id}": context.lead_id or "",
        }
        
        for placeholder, value in replacements.items():
            result = result.replace(placeholder, value)
        
        # Environment variables: ${VAR_NAME}
        env_pattern = r'\$\{([A-Z_][A-Z0-9_]*)\}'
        def env_replacer(match):
            var_name = match.group(1)
            return os.environ.get(var_name, "")
        
        result = re.sub(env_pattern, env_replacer, result)
        
        return result
    
    def _redact_url(self, url: str) -> str:
        """Redact sensitive parts of URL for logging."""
        redacted = re.sub(r'(api_key|apikey|key|token|auth)=([^&]+)', r'\1=***', url, flags=re.IGNORECASE)
        return redacted
    
    def _build_summary_transcript(self, context: PostCallContext) -> str:
        """Flatten conversation history into a simple transcript string."""
        return "\n".join([
            f"{msg.get('role', 'unknown')}: {msg.get('content', '')}"
            for msg in context.conversation_history
        ])

    @staticmethod
    def _extract_google_summary_text(payload: Dict[str, Any]) -> str:
        """Extract plain text from a Google generateContent response."""
        candidates = payload.get("candidates") or []
        for candidate in candidates:
            content = candidate.get("content") or {}
            parts = content.get("parts") or []
            texts = [
                part.get("text", "").strip()
                for part in parts
                if isinstance(part, dict) and part.get("text")
            ]
            if texts:
                return "\n".join(texts).strip()
        return ""

    async def _generate_summary_with_google(self, context: PostCallContext) -> str:
        """Generate a concise summary of the conversation using Gemini."""
        transcript_text = self._build_summary_transcript(context)
        if not transcript_text.strip():
            return ""

        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            logger.warning(f"Cannot generate summary - GOOGLE_API_KEY not set: {self.config.name}")
            return ""

        model = self.config.summary_model or "gemini-2.5-flash"
        max_words = self.config.summary_max_words
        payload = {
            "systemInstruction": {
                "parts": [{
                    "text": (
                        "You are a call summarizer. Summarize the following phone "
                        f"conversation in {max_words} words or less. Focus on the "
                        "caller's main request, key information exchanged, and the "
                        "outcome. Be concise and factual."
                    )
                }]
            },
            "contents": [{
                "role": "user",
                "parts": [{"text": transcript_text}],
            }],
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": 200,
            },
        }
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        timeout = aiohttp.ClientTimeout(total=max(5.0, self.config.timeout_ms / 1000.0))

        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, params={"key": api_key}, json=payload) as response:
                    body = await response.text()
                    if response.status >= 400:
                        logger.warning(
                            "Failed to generate summary with Gemini: %s status=%s body=%s",
                            self.config.name,
                            response.status,
                            body[:200],
                        )
                        return ""
            data = json.loads(body)
            summary = self._extract_google_summary_text(data)
            if summary:
                logger.info(f"Generated Gemini summary for webhook: {self.config.name} length={len(summary)}")
            return summary
        except Exception as e:
            logger.warning(f"Failed to generate summary with Gemini: {self.config.name} error={e}")
            return ""

    async def _generate_summary_with_openai(self, context: PostCallContext) -> str:
        """Generate a concise summary of the conversation using OpenAI."""
        transcript_text = self._build_summary_transcript(context)
        if not transcript_text.strip():
            return ""

        if openai is None:
            logger.warning(f"Cannot generate summary - openai package not installed: {self.config.name}")
            return ""

        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            logger.warning(f"Cannot generate summary - OPENAI_API_KEY not set: {self.config.name}")
            return ""

        client = openai.AsyncOpenAI(api_key=api_key)
        model = self.config.summary_model or "gpt-4o-mini"
        max_words = self.config.summary_max_words

        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a call summarizer. Summarize the following phone "
                            f"conversation in {max_words} words or less. Focus on: the "
                            "caller's main request, key information exchanged, and the "
                            "outcome. Be concise and factual."
                        ),
                    },
                    {
                        "role": "user",
                        "content": transcript_text,
                    },
                ],
                max_tokens=200,
                temperature=0.3,
            )
            summary = response.choices[0].message.content.strip() if response.choices else ""
            logger.info(f"Generated OpenAI summary for webhook: {self.config.name} length={len(summary)}")
            return summary
        except Exception as e:
            logger.warning(f"Failed to generate summary with OpenAI: {self.config.name} error={e}")
            return ""

    async def _generate_summary(self, context: PostCallContext) -> str:
        """
        Generate a concise summary of the conversation using the configured LLM.
        
        Returns:
            Summary string, or empty string if generation fails.
        """
        if not context.conversation_history:
            return ""

        provider = (self.config.summary_provider or "google").strip().lower()
        if provider in {"google", "gemini", "google_live"}:
            return await self._generate_summary_with_google(context)
        if provider in {"openai", "gpt", "openai_realtime"}:
            return await self._generate_summary_with_openai(context)

        logger.warning(
            "Cannot generate summary - unsupported summary_provider '%s': %s",
            self.config.summary_provider,
            self.config.name,
        )
        return ""


def create_webhook_tool(name: str, config_dict: Dict[str, Any]) -> GenericWebhookTool:
    """
    Factory function to create a webhook tool from YAML config.
    
    Args:
        name: Tool name from YAML key
        config_dict: Tool configuration dictionary
    
    Returns:
        Configured GenericWebhookTool instance
    """
    config = WebhookConfig(
        name=name,
        enabled=config_dict.get('enabled', True),
        phase=config_dict.get('phase', 'post_call'),
        is_global=config_dict.get('is_global', False),
        timeout_ms=config_dict.get('timeout_ms', 5000),
        url=config_dict.get('url', ''),
        method=config_dict.get('method', 'POST'),
        headers=config_dict.get('headers', {}),
        payload_template=config_dict.get('payload_template'),
        content_type=config_dict.get('content_type', 'application/json'),
        require_ack=config_dict.get('require_ack', False),
        generate_summary=config_dict.get('generate_summary', False),
        summary_max_words=config_dict.get('summary_max_words', 100),
        summary_provider=config_dict.get('summary_provider', 'google'),
        summary_model=config_dict.get('summary_model'),
    )
    
    return GenericWebhookTool(config)
