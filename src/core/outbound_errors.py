"""Normalized, safe diagnostics for the outbound campaign dialer."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Optional


ERROR_STAGES = {"originate", "provider_sip", "ava_session", "voicemail"}


@dataclass(frozen=True)
class OutboundFailure:
    stage: str
    code: str
    message: str
    retryable: bool


_AUTH_RE = re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_URL_CREDENTIAL_RE = re.compile(r"(https?://)([^/@\s:]+):([^/@\s]+)@", re.IGNORECASE)
_KEY_VALUE_RE = re.compile(
    r"(?i)(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret)\b\s*[=:]\s*)([^\s,;&]+)"
)
_QUERY_SECRET_RE = re.compile(
    r"(?i)([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)=)([^&#\s]+)"
)


def sanitize_outbound_error(value: Any, *, max_length: int = 1000) -> str:
    """Redact credentials before an error is persisted or returned by the API."""
    text = str(value or "").replace("\x00", " ").strip()
    text = _AUTH_RE.sub(r"\1 ***REDACTED***", text)
    text = _URL_CREDENTIAL_RE.sub(r"\1***REDACTED***:***REDACTED***@", text)
    text = _KEY_VALUE_RE.sub(r"\1***REDACTED***", text)
    text = _QUERY_SECRET_RE.sub(r"\1***REDACTED***", text)

    # Remove exact configured secret values as a final guard. Ignore very short values
    # to avoid corrupting ordinary words/numbers in diagnostics.
    for key, secret in os.environ.items():
        normalized_key = key.lower()
        if not any(part in normalized_key for part in ("key", "token", "secret", "password", "passwd", "pwd")):
            continue
        secret = str(secret or "")
        if len(secret) >= 6:
            text = text.replace(secret, "***REDACTED***")

    return text[: max(1, int(max_length))]


def originate_failure(status: Optional[int], reason: Any) -> OutboundFailure:
    try:
        status_i = int(status or 0)
    except Exception:
        status_i = 0
    retryable = status_i == 0 or status_i >= 500 or status_i in {408, 409, 425, 429}
    code = "originate_transport_error" if status_i == 0 else f"ari_http_{status_i}"
    message = sanitize_outbound_error(reason or "originate failed")
    return OutboundFailure("originate", code, message, retryable)


_SIP_RETRYABLE_CAUSES = {
    17: "busy",
    18: "no_user_response",
    19: "no_answer",
    27: "destination_out_of_order",
    31: "normal_unspecified",
    34: "no_circuit_available",
    38: "network_out_of_order",
    41: "temporary_failure",
    42: "switch_congestion",
    44: "channel_unavailable",
    47: "resource_unavailable",
}
_SIP_TERMINAL_CAUSES = {
    1: "unallocated_number",
    2: "no_route_to_network",
    3: "no_route_to_destination",
    21: "call_rejected",
    22: "number_changed",
    28: "invalid_number_format",
    29: "facility_rejected",
    57: "bearer_capability_not_authorized",
    58: "bearer_capability_unavailable",
    63: "service_unavailable",
    79: "service_not_implemented",
    88: "incompatible_destination",
}


def sip_failure(cause: Any, cause_text: Any) -> OutboundFailure:
    try:
        cause_i = int(cause)
    except Exception:
        cause_i = 0
    text = sanitize_outbound_error(cause_text or "provider/SIP call failed")
    lowered = text.lower()

    label = _SIP_RETRYABLE_CAUSES.get(cause_i)
    retryable = label is not None
    if label is None:
        label = _SIP_TERMINAL_CAUSES.get(cause_i)
    if label is None:
        if "busy" in lowered:
            label, retryable = "busy", True
        elif "no answer" in lowered or "noanswer" in lowered:
            label, retryable = "no_answer", True
        elif any(token in lowered for token in ("congestion", "temporary", "chanunavail", "unavailable")):
            label, retryable = "temporary_provider_failure", True
        elif any(token in lowered for token in ("unallocated", "invalid number", "forbidden", "rejected")):
            label, retryable = "terminal_provider_failure", False
        elif not lowered or "unknown" in lowered:
            # Asterisk commonly emits Unknown for originate timeouts that never answered.
            label, retryable = "no_answer", True
        else:
            label, retryable = "unclassified_provider_failure", False

    prefix = f"sip_cause_{cause_i}" if cause_i else "sip"
    return OutboundFailure("provider_sip", f"{prefix}_{label}", text, retryable)


def terminal_failure(stage: str, code: str, message: Any) -> OutboundFailure:
    safe_stage = stage if stage in ERROR_STAGES else "ava_session"
    safe_code = re.sub(r"[^a-z0-9_.-]+", "_", str(code or "error").lower()).strip("_") or "error"
    return OutboundFailure(safe_stage, safe_code, sanitize_outbound_error(message), False)

