#!/usr/bin/env python3
"""MCP bridge from AVA voice runtime to WhatsApp CRM Sales Brain API."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from src.mcp.stdio_framing import decode_frame, encode_message


def _base_url() -> str:
    return os.getenv("SALES_BRAIN_BASE_URL", os.getenv("WHATSAPP_CRM_BASE_URL", "http://127.0.0.1:3011")).rstrip("/")


def _token() -> str:
    return os.getenv("SALES_BRAIN_API_TOKEN", os.getenv("CRM_SERVICE_API_TOKEN", "")).strip()


def _default_instance_id() -> int:
    return int(os.getenv("SALES_BRAIN_DEFAULT_INSTANCE_ID", os.getenv("WHATSAPP_CRM_DEFAULT_INSTANCE_ID", "1")) or "1")


def _timeout_sec() -> float:
    return max(1.0, int(os.getenv("SALES_BRAIN_TIMEOUT_MS", "7000") or "7000") / 1000.0)


def _voice_result(spoken: str, **structured: Any) -> Dict[str, Any]:
    data = {"spoken": spoken}
    data.update(structured)
    return {"content": [{"type": "text", "text": spoken}], "structured": data}


def _headers() -> Dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    body = dict(payload or {})
    body.setdefault("instanceId", _default_instance_id())
    url = f"{_base_url()}{path}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=_headers(),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_timeout_sec()) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, dict) else {"value": data}


def _safe_call(path: str, payload: Dict[str, Any], failure_spoken: str) -> Dict[str, Any]:
    try:
        result = _post_json(path, payload)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
        return _voice_result(failure_spoken, status="error", error=str(exc))
    spoken = str(result.get("spoken") or result.get("summary_for_voice") or result.get("answer") or "")
    nested = result.get("result") if isinstance(result.get("result"), dict) else None
    if nested and not spoken:
        spoken = str(nested.get("spoken") or nested.get("answer") or "")
    status = str(result.get("status") or ("error" if result.get("success") is False else "ok"))
    controls = {key: result[key] for key in ("sent", "draft_id", "requires_approval", "error") if key in result}
    return _voice_result(spoken or ("Не удалось выполнить действие." if status == "error" else "Готово."),
                         status=status, output=result, **controls)


def resolve_customer(phone: str, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/customer/resolve",
        {"phone": phone, "instanceId": instance_id or _default_instance_id()},
        "Sales Brain сейчас недоступен, поэтому я не могу найти клиента.",
    )


def customer_summary(phone: str, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/customer/summary",
        {"phone": phone, "instanceId": instance_id or _default_instance_id()},
        "Sales Brain сейчас недоступен, поэтому я не могу получить выжимку по клиенту.",
    )


def get_timeline(phone: str, instance_id: Optional[int] = None, limit: int = 10) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/customer/timeline",
        {"phone": phone, "instanceId": instance_id or _default_instance_id(), "limit": limit},
        "Sales Brain сейчас недоступен, поэтому я не могу получить историю клиента.",
    )


def answer_from_knowledge(question: str, instance_id: Optional[int] = None,
                          caller_number: Optional[str] = None, call_id: Optional[str] = None) -> Dict[str, Any]:
    payload = {"question": question, "channel": "voice", "instanceId": instance_id or _default_instance_id()}
    if caller_number:
        payload["callerNumber"] = caller_number
    if call_id:
        payload["callId"] = call_id
    return _safe_call(
        "/api/ml/rag/answer",
        payload,
        "База знаний сейчас недоступна, поэтому я не могу проверить точный ответ.",
    )


def get_next_action(phone: str, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/next-action",
        {"phone": phone, "instanceId": instance_id or _default_instance_id()},
        "Sales Brain сейчас недоступен, поэтому я не могу подсказать следующий шаг.",
    )


def create_crm_note(phone: str, note: str, call_id: Optional[str] = None, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/crm-note",
        {"phone": phone, "note": note, "callId": call_id, "channel": "voice", "instanceId": instance_id or _default_instance_id()},
        "Не удалось сохранить заметку в CRM.",
    )


def create_manager_task(
    phone: str,
    task: str,
    priority: str = "normal",
    call_id: Optional[str] = None,
    instance_id: Optional[int] = None,
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    # `reason` is optional so existing callers keep working; the CRM normalizes
    # an unknown or missing value to 'manual'.
    payload: Dict[str, Any] = {
        "phone": phone,
        "task": task,
        "priority": priority,
        "callId": call_id,
        "instanceId": instance_id or _default_instance_id(),
    }
    if reason:
        payload["reason"] = reason
    return _safe_call(
        "/api/ml/manager-task",
        payload,
        "Не удалось создать задачу менеджеру.",
    )


def update_stage(phone: str, stage: str, reason: str, instance_id: Optional[int] = None, call_id: Optional[str] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/stage/update",
        {"phone": phone, "stage": stage, "reason": reason, "instanceId": instance_id or _default_instance_id(), "callId": call_id},
        "Не удалось обновить статус клиента.",
    )


def draft_whatsapp_followup(phone: str, text: Optional[str] = None, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/followup/draft",
        {"phone": phone, "text": text, "instanceId": instance_id or _default_instance_id()},
        "Не удалось подготовить WhatsApp follow-up.",
    )


def send_whatsapp_followup(phone: str, text: str, confirmed: bool = False, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call(
        "/api/ml/followup/send",
        {"phone": phone, "text": text, "confirmed": confirmed, "instanceId": instance_id or _default_instance_id()},
        "Не удалось отправить WhatsApp follow-up.",
    )



def draft_followup(target_channel: str, text: Optional[str] = None, caller_number: Optional[str] = None,
                   call_id: Optional[str] = None, instance_id: Optional[int] = None) -> Dict[str, Any]:
    return _safe_call('/api/ml/followup/draft', {
        'phone': caller_number or '', 'channel': target_channel, 'text': text,
        'callId': call_id, 'instanceId': instance_id or _default_instance_id(),
    }, 'Не удалось подготовить сообщение клиенту.')


def send_followup(target_channel: str, text: str, confirmed: bool = False,
                  caller_number: Optional[str] = None, call_id: Optional[str] = None,
                  instance_id: Optional[int] = None, draft_id: Optional[str] = None) -> Dict[str, Any]:
    return _safe_call('/api/ml/followup/send', {
        'phone': caller_number or '', 'channel': target_channel, 'text': text,
        'callId': call_id, 'instanceId': instance_id or _default_instance_id(),
        'draftId': draft_id, 'confirmed': confirmed, 'voiceRequest': True,
    }, 'Не удалось подтвердить отправку сообщения клиенту.')


def _tool_schema(name: str, description: str, properties: Dict[str, Any], required: list[str]) -> Dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required,
        },
    }


def _tools_list() -> Dict[str, Any]:
    phone = {"type": "string", "description": "Customer phone number."}
    instance_id = {"type": "integer", "description": "WhatsApp CRM instance id. Defaults to env."}
    return {
        "tools": [
            _tool_schema("resolve_customer", "Resolve a CRM customer by phone.", {"phone": phone, "instance_id": instance_id}, ["phone"]),
            _tool_schema("customer_summary", "Get current caller context and available_channels from the confirmed CRM card. Check this before choosing a channel; linked WhatsApp can have another number and Telegram can have no phone.", {"phone": phone, "instance_id": instance_id}, ["phone"]),
            _tool_schema("get_timeline", "Get short customer timeline across CRM events/messages.", {"phone": phone, "instance_id": instance_id, "limit": {"type": "integer"}}, ["phone"]),
            _tool_schema("answer_from_knowledge", "Answer a business question from shared RAG knowledge base.", {
                "question": {"type": "string"}, "instance_id": instance_id,
                "caller_number": {"type": "string", "description": "Filled by AVA from the current call; not user-selectable."},
                "call_id": {"type": "string", "description": "Filled by AVA from the current call."},
            }, ["question"]),
            _tool_schema("get_next_action", "Get recommended next best action for a customer.", {"phone": phone, "instance_id": instance_id}, ["phone"]),
            _tool_schema("create_crm_note", "Create a low-risk internal CRM note.", {"phone": phone, "note": {"type": "string"}, "call_id": {"type": "string"}, "instance_id": instance_id}, ["phone", "note"]),
            _tool_schema(
                "create_manager_task",
                "Create a low-risk handoff task for a human manager.",
                {
                    "phone": phone,
                    "task": {"type": "string"},
                    "priority": {"type": "string", "enum": ["low", "normal", "high", "urgent"]},
                    "reason": {
                        "type": "string",
                        "enum": [
                            "guest_request",
                            "missing_fact",
                            "booking_change",
                            "booking_request",
                            "complaint",
                            "payment",
                            "sensitive_data",
                            "repeated_misunderstanding",
                            "transfer_failed",
                            "manual",
                            "other",
                        ],
                    },
                    "call_id": {"type": "string"},
                    "instance_id": instance_id,
                },
                ["phone", "task"],
            ),
            _tool_schema("update_stage", "Update lead stage with policy guard.", {"call_id": {"type": "string", "description": "Filled by AVA from the current call."}, "phone": phone, "stage": {"type": "string", "enum": ["new", "qualified", "audit", "offer", "pickup_confirmed", "ready_for_pickup", "booked", "junk"]}, "reason": {"type": "string"}, "instance_id": instance_id}, ["phone", "stage", "reason"]),
            _tool_schema('draft_followup', 'Prepare requested information for the CURRENT caller in a confirmed linked channel. Does not send.', {
                'target_channel': {'type': 'string', 'enum': ['whatsapp', 'telegram', 'email', 'vk', 'max', 'avito']},
                'text': {'type': 'string'}, 'caller_number': {'type': 'string', 'description': 'Filled by AVA from the current call; never invent a recipient.'},
                'call_id': {'type': 'string', 'description': 'Filled by AVA from the current call.'}, 'instance_id': instance_id,
            }, ['target_channel']),
            _tool_schema('send_followup', 'Submit the CURRENT caller requested message through an existing linked channel. Owner automation and manager approval rules apply. Say sent ONLY when sent=true; pending or needs_approval is not delivery.', {
                'target_channel': {'type': 'string', 'enum': ['whatsapp', 'telegram', 'email', 'vk', 'max', 'avito']},
                'text': {'type': 'string'}, 'confirmed': {'type': 'boolean'}, 'draft_id': {'type': 'string'},
                'caller_number': {'type': 'string', 'description': 'Filled by AVA from the current call; never invent a recipient.'},
                'call_id': {'type': 'string', 'description': 'Filled by AVA from the current call.'}, 'instance_id': instance_id,
            }, ['target_channel', 'text', 'confirmed']),
            _tool_schema(
                "draft_whatsapp_followup",
                "Draft a WhatsApp follow-up for a human to review. Does not send.",
                {"phone": phone, "text": {"type": "string"}, "instance_id": instance_id},
                ["phone"],
            ),
            _tool_schema(
                "send_whatsapp_followup",
                (
                    "Queue a WhatsApp follow-up for manager approval. This does NOT deliver "
                    "the message: a human approves it in the CRM first. Tell the caller the "
                    "follow-up will be sent, never that it has already been sent."
                ),
                {"phone": phone, "text": {"type": "string"}, "confirmed": {"type": "boolean"}, "instance_id": instance_id},
                ["phone", "text", "confirmed"],
            ),
        ]
    }


def _handle_call(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    args = arguments or {}
    instance_id = int(args.get("instance_id")) if args.get("instance_id") is not None else None
    if name == "resolve_customer":
        return resolve_customer(str(args.get("phone") or ""), instance_id)
    if name == "customer_summary":
        return customer_summary(str(args.get("phone") or ""), instance_id)
    if name == "get_timeline":
        return get_timeline(str(args.get("phone") or ""), instance_id, int(args.get("limit") or 10))
    if name == "answer_from_knowledge":
        return answer_from_knowledge(str(args.get("question") or ""), instance_id, args.get("caller_number"), args.get("call_id"))
    if name == "get_next_action":
        return get_next_action(str(args.get("phone") or ""), instance_id)
    if name == "create_crm_note":
        return create_crm_note(str(args.get("phone") or ""), str(args.get("note") or ""), args.get("call_id"), instance_id)
    if name == "create_manager_task":
        return create_manager_task(
            str(args.get("phone") or ""),
            str(args.get("task") or ""),
            str(args.get("priority") or "normal"),
            args.get("call_id"),
            instance_id,
            reason=args.get("reason"),
        )
    if name == "update_stage":
        return update_stage(str(args.get("phone") or ""), str(args.get("stage") or ""), str(args.get("reason") or ""), instance_id, args.get("call_id"))
    if name == 'draft_followup':
        return draft_followup(str(args.get('target_channel') or ''), args.get('text'), args.get('caller_number'), args.get('call_id'), instance_id)
    if name == 'send_followup':
        return send_followup(str(args.get('target_channel') or ''), str(args.get('text') or ''), args.get('confirmed') is True,
                             args.get('caller_number'), args.get('call_id'), instance_id, args.get('draft_id'))
    if name == "draft_whatsapp_followup":
        return draft_whatsapp_followup(str(args.get("phone") or ""), args.get("text"), instance_id)
    if name == "send_whatsapp_followup":
        return send_whatsapp_followup(str(args.get("phone") or ""), str(args.get("text") or ""), args.get("confirmed") is True, instance_id)
    return _voice_result("Unknown Sales Brain tool.", status="error")


def _write(payload: Dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_message(payload))
    sys.stdout.buffer.flush()


def _result(request_id: Any, result: Dict[str, Any]) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": int(code), "message": message}})


def main() -> int:
    buffer = bytearray()
    stdin = sys.stdin.buffer
    while True:
        chunk = stdin.read(1)
        if not chunk:
            return 0
        buffer.extend(chunk)
        while True:
            msg, consumed = decode_frame(buffer)
            if msg is None:
                break
            del buffer[:consumed]
            method = msg.get("method")
            request_id = msg.get("id")
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            try:
                if method == "initialize":
                    _result(request_id, {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "sales_brain", "version": "1.0.0"}})
                elif method == "tools/list":
                    _result(request_id, _tools_list())
                elif method == "tools/call":
                    _result(request_id, _handle_call(str(params.get("name") or ""), params.get("arguments") or {}))
                elif method == "notifications/initialized":
                    pass
                elif request_id is not None:
                    _result(request_id, {})
            except Exception as exc:
                _error(request_id, -32000, str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
