#!/usr/bin/env python3
"""Read-only MCP tools for the bundled WhatsApp CRM."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from src.mcp.stdio_framing import decode_frame, encode_message


def _base_url() -> str:
    return os.getenv("WHATSAPP_CRM_BASE_URL", "http://127.0.0.1:3011").rstrip("/")


def _public_url() -> str:
    return os.getenv("WHATSAPP_CRM_PUBLIC_URL", _base_url()).rstrip("/")


def _default_instance_id() -> int:
    return int(os.getenv("WHATSAPP_CRM_DEFAULT_INSTANCE_ID", "1") or "1")


def _timeout_sec() -> float:
    return max(1.0, int(os.getenv("WHATSAPP_CRM_TIMEOUT_MS", "5000") or "5000") / 1000.0)


def _api_token() -> str:
    return os.getenv("WHATSAPP_CRM_API_TOKEN", os.getenv("CRM_SERVICE_API_TOKEN", "")).strip()


def _digits(value: str) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _voice_result(spoken: str, **structured: Any) -> Dict[str, Any]:
    data = {"spoken": spoken}
    data.update(structured)
    return {"content": [{"type": "text", "text": spoken}], "structured": data}


def _write(payload: Dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_message(payload))
    sys.stdout.buffer.flush()


def _result(request_id: Any, result: Dict[str, Any]) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": int(code), "message": message}})


def _http_get_json(path: str) -> Dict[str, Any]:
    url = f"{_base_url()}{path}"
    headers = {"Accept": "application/json"}
    token = _api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=_timeout_sec()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    url = f"{_base_url()}{path}"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    token = _api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = dict(payload or {})
    body.setdefault("instanceId", _default_instance_id())
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_timeout_sec()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _safe_client(client: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "chatId": client.get("chatId"),
        "senderName": client.get("senderName"),
        "leadStatus": client.get("leadStatus"),
        "lastMessage": client.get("lastMessage"),
        "lastMessageTime": client.get("lastMessageTime"),
        "preferredChannel": client.get("preferredChannel"),
        "detectedLanguage": client.get("detectedLanguage"),
        "tags": client.get("tags"),
        "updatedAt": client.get("updatedAt"),
    }


def _clip_text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        return text[: max(0, limit - 3)].rstrip() + "..."
    return text


def _crm_conversation_url(instance_id: int, chat_id: str) -> str:
    return f"{_public_url()}/conversations?chat={urllib.parse.quote(chat_id, safe='')}"


def _load_clients(instance_id: int) -> List[Dict[str, Any]]:
    data = _http_get_json(f"/api/clients/{int(instance_id)}")
    clients = data.get("clients") if isinstance(data, dict) else []
    return clients if isinstance(clients, list) else []


def _find_client(phone: str, instance_id: int) -> Optional[Dict[str, Any]]:
    target = _digits(phone)
    if not target:
        return None
    for client in _load_clients(instance_id):
        chat_digits = _digits(str(client.get("chatId") or ""))
        if chat_digits.endswith(target) or target.endswith(chat_digits):
            return client
    return None


def lookup_whatsapp_client(phone: str, instance_id: Optional[int] = None) -> Dict[str, Any]:
    safe_instance_id = int(instance_id or _default_instance_id())
    if _api_token():
        try:
            data = _http_post_json("/api/ml/customer/resolve", {"phone": phone, "instanceId": safe_instance_id})
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            spoken = "WhatsApp CRM сейчас недоступна, поэтому я не могу проверить этого клиента."
            return _voice_result(spoken, found=False, error=str(exc))
        if not data.get("found"):
            spoken = data.get("spoken") or f"Я не нашел клиента с номером {phone} в WhatsApp CRM."
            return _voice_result(spoken, found=False, phone=_digits(phone), instance_id=safe_instance_id)
        client = data.get("client") if isinstance(data.get("client"), dict) else {}
        chat_id = str(data.get("chatId") or client.get("chatId") or "")
        spoken = data.get("spoken") or f"Нашел клиента {client.get('senderName') or 'без имени'}."
        return _voice_result(
            spoken,
            found=True,
            phone=data.get("phone") or _digits(phone),
            instance_id=safe_instance_id,
            client=client,
            identity_confidence=data.get("identity_confidence"),
            crm_url=_crm_conversation_url(safe_instance_id, chat_id),
        )

    try:
        client = _find_client(phone, safe_instance_id)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        spoken = "WhatsApp CRM сейчас недоступна, поэтому я не могу проверить этого клиента."
        return _voice_result(spoken, found=False, error=str(exc))
    if not client:
        spoken = f"Я не нашел клиента с номером {phone} в WhatsApp CRM."
        return _voice_result(spoken, found=False, phone=_digits(phone), instance_id=safe_instance_id)
    safe = _safe_client(client)
    name = safe.get("senderName") or "клиент"
    status = safe.get("leadStatus") or "неизвестен"
    last_message = _clip_text(safe.get("lastMessage"), 180) or "свежих сообщений нет"
    spoken = f"Нашел клиента {name} в WhatsApp CRM. Статус: {status}. Последнее сообщение: {last_message}"
    return _voice_result(
        spoken,
        found=True,
        phone=_digits(phone),
        instance_id=safe_instance_id,
        client=safe,
        crm_url=_crm_conversation_url(safe_instance_id, str(safe.get("chatId") or "")),
    )


def _load_messages(instance_id: int, chat_id: str) -> List[Dict[str, Any]]:
    encoded = urllib.parse.quote(chat_id, safe="")
    data = _http_get_json(f"/api/messages/{int(instance_id)}/{encoded}")
    messages = data.get("messages") if isinstance(data, dict) else []
    return messages if isinstance(messages, list) else []


def _infer_next_step(client: Dict[str, Any], messages: List[Dict[str, Any]]) -> str:
    status = str(client.get("leadStatus") or "new").lower()
    if status in {"qualified", "offer", "audit"}:
        return "ответить конкретным предложением или довести клиента до записи"
    if status in {"booked", "paid"}:
        return "подтвердить детали и поддерживать контакт"
    if not messages:
        return "отправить первое follow-up сообщение"
    last_role = str(messages[-1].get("role") or "")
    return "ответить на последнее сообщение клиента" if last_role == "user" else "подождать ответа клиента или запланировать follow-up"


def summarize_whatsapp_conversation(
    phone: str,
    instance_id: Optional[int] = None,
    message_limit: int = 20,
) -> Dict[str, Any]:
    safe_instance_id = int(instance_id or _default_instance_id())
    if _api_token():
        try:
            data = _http_post_json("/api/ml/customer/summary", {"phone": phone, "instanceId": safe_instance_id})
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            spoken = "WhatsApp CRM сейчас недоступна, поэтому я не могу сделать выжимку переписки."
            return _voice_result(spoken, found=False, error=str(exc))
        if not data.get("found"):
            spoken = data.get("spoken") or f"Я не нашел переписку WhatsApp для номера {phone}."
            return _voice_result(spoken, found=False, phone=_digits(phone), instance_id=safe_instance_id)
        client = data.get("client") if isinstance(data.get("client"), dict) else {}
        chat_id = str(data.get("chatId") or client.get("chatId") or "")
        spoken = data.get("spoken") or data.get("summary_for_voice") or "Нашел выжимку по клиенту в WhatsApp CRM."
        return _voice_result(
            spoken,
            found=True,
            phone=data.get("phone") or _digits(phone),
            instance_id=safe_instance_id,
            client=client,
            summary_for_voice=data.get("summary_for_voice"),
            profile=data.get("profile"),
            coffee_context=data.get("coffee_context"),
            next_action=data.get("next_action"),
            crm_url=_crm_conversation_url(safe_instance_id, chat_id),
        )

    try:
        client = _find_client(phone, safe_instance_id)
        if not client:
            spoken = f"Я не нашел переписку WhatsApp для номера {phone}."
            return _voice_result(spoken, found=False, phone=_digits(phone), instance_id=safe_instance_id)
        messages = _load_messages(safe_instance_id, str(client.get("chatId") or ""))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        spoken = "WhatsApp CRM сейчас недоступна, поэтому я не могу сделать выжимку переписки."
        return _voice_result(spoken, found=False, error=str(exc))

    safe_limit = max(1, min(int(message_limit or 20), 50))
    recent = messages[-safe_limit:]
    last_user = next((m for m in reversed(recent) if str(m.get("role")) == "user"), None)
    last_assistant = next((m for m in reversed(recent) if str(m.get("role")) == "assistant"), None)
    client_name = client.get("senderName") or "клиент"
    status = client.get("leadStatus") or "неизвестен"
    last_user_text = _clip_text((last_user or {}).get("content"), 160)
    last_assistant_text = _clip_text((last_assistant or {}).get("content"), 160)
    next_step = _infer_next_step(client, recent)

    spoken_parts = [
        f"В WhatsApp CRM у клиента {client_name} статус: {status}.",
        f"Последнее сообщение клиента: {last_user_text or 'свежих сообщений от клиента нет'}.",
        f"Рекомендуемый следующий шаг: {next_step}.",
    ]
    spoken = " ".join(spoken_parts)
    return _voice_result(
        spoken,
        found=True,
        phone=_digits(phone),
        instance_id=safe_instance_id,
        client=_safe_client(client),
        message_count=len(messages),
        recent_messages=[
            {
                "role": m.get("role"),
                "senderName": m.get("senderName"),
                "content": str(m.get("content") or "")[:240],
                "timestamp": m.get("timestamp"),
                "channel": m.get("channel"),
            }
            for m in recent[-5:]
        ],
        last_assistant_message=last_assistant_text,
        next_step=next_step,
        crm_url=_crm_conversation_url(safe_instance_id, str(client.get("chatId") or "")),
    )


def _tools_list() -> Dict[str, Any]:
    return {
        "tools": [
            {
                "name": "lookup_whatsapp_client",
                "description": "Read-only lookup of a WhatsApp CRM client by phone number.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "phone": {"type": "string", "description": "Client phone number."},
                        "instance_id": {"type": "integer", "description": "WhatsApp CRM instance id. Defaults to 1."},
                    },
                    "required": ["phone"],
                },
            },
            {
                "name": "summarize_whatsapp_conversation",
                "description": "Read-only voice-safe summary of a WhatsApp CRM conversation by phone number.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "phone": {"type": "string", "description": "Client phone number."},
                        "instance_id": {"type": "integer", "description": "WhatsApp CRM instance id. Defaults to 1."},
                        "message_limit": {"type": "integer", "description": "How many recent messages to inspect, 1 to 50."},
                    },
                    "required": ["phone"],
                },
            },
        ]
    }


def _handle_call(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    args = arguments or {}
    if name == "lookup_whatsapp_client":
        return lookup_whatsapp_client(
            str(args.get("phone") or ""),
            int(args.get("instance_id")) if args.get("instance_id") is not None else None,
        )
    if name == "summarize_whatsapp_conversation":
        return summarize_whatsapp_conversation(
            str(args.get("phone") or ""),
            int(args.get("instance_id")) if args.get("instance_id") is not None else None,
            int(args.get("message_limit") or 20),
        )
    return _voice_result("Unknown tool.")


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
                    _result(
                        request_id,
                        {
                            "protocolVersion": "2024-11-05",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "whatsapp_crm", "version": "1.0.0"},
                        },
                    )
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
