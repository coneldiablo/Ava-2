#!/usr/bin/env python3
"""Read-only Bnovo PMS MCP bridge for the AVA voice runtime."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict

from src.mcp.stdio_framing import decode_frame, encode_message


def _base_url() -> str:
    return os.getenv("WHATSAPP_CRM_BASE_URL", os.getenv("SALES_BRAIN_BASE_URL", "http://127.0.0.1:3011")).rstrip("/")


def _headers() -> Dict[str, str]:
    token = os.getenv("CRM_SERVICE_API_TOKEN", os.getenv("SALES_BRAIN_API_TOKEN", "")).strip()
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        **({"Authorization": f"Bearer {token}"} if token else {}),
    }


def _post(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    request = urllib.request.Request(
        f"{_base_url()}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers=_headers(),
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=float(os.getenv("PMS_TOOL_TIMEOUT_SECONDS", "15"))) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict) or result.get("success") is False:
        raise RuntimeError(str(result.get("error") if isinstance(result, dict) else "PMS request failed"))
    return result


def _voice(spoken: str, **data: Any) -> Dict[str, Any]:
    structured = {"spoken": spoken, **data}
    return {"content": [{"type": "text", "text": spoken}], "structured": structured}


def _safe(
    path: str,
    payload: Dict[str, Any],
    formatter,
    *,
    unavailable_spoken: str = "Сервис Bnovo сейчас недоступен. Можно повторить проверку позже.",
) -> Dict[str, Any]:
    try:
        result = _post(path, payload)
        return _voice(formatter(result), status="ok", output=result)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
        return _voice(
            unavailable_spoken,
            status="error",
            error_code="PMS_UNAVAILABLE",
            manager_task_created=False,
            requires_manager=False,
            can_continue=True,
            # Keep the voice-facing result deliberately generic. Detailed,
            # redacted diagnostics stay in the service audit log.
            retryable=isinstance(error, (urllib.error.URLError, TimeoutError)),
        )


def _lookup_spoken(result: Dict[str, Any]) -> str:
    bookings = result.get("bookings") or []
    if not bookings:
        return "Я не нашла подходящую бронь в этом отеле. Давайте проверим номер бронирования и фамилию."
    booking = bookings[0]
    return (
        f"Бронь {booking.get('booking_number') or ''}: заезд {booking.get('arrival') or 'не указан'}, "
        f"выезд {booking.get('departure') or 'не указан'}, статус {booking.get('status') or 'не указан'}."
    )


def _availability_spoken(result: Dict[str, Any]) -> str:
    if result.get("live_check_available") is False:
        return (
            "Онлайн-проверка наличия и цены сейчас недоступна, поэтому я пока "
            "не могу подтвердить эти данные. Я могу продолжить отвечать на вопросы "
            "об отеле, а заявку на проверку оформлю только по вашему желанию."
        )
    categories = result.get("categories") or []
    if not categories:
        return "На указанные даты доступных категорий по подключенным тарифам не найдено."
    category = categories[0]
    offer = (category.get("offers") or [{}])[0]
    return (
        f"Доступна категория {category.get('category')}. "
        f"Стоимость за весь период {offer.get('total')} {offer.get('currency', 'RUB')}."
    )


def _request_spoken(result: Dict[str, Any]) -> str:
    if result.get("request_id"):
        return "Заявка на бронирование создана и передана менеджеру. Он свяжется с вами для подтверждения."
    return "Не удалось создать заявку. Я передам запрос менеджеру другим способом."


COMMON = {
    "business_id": {"type": "integer", "description": "Injected current hotel business id."},
    "instance_id": {"type": "integer", "description": "Injected current hotel instance id."},
    "call_id": {"type": "string", "description": "Injected current call id."},
    "caller_number": {"type": "string", "description": "Injected current caller phone."},
    "channel": {"type": "string", "enum": ["voice", "whatsapp"]},
}


def _schema(name: str, description: str, properties: Dict[str, Any], required: list[str]) -> Dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {**COMMON, **properties},
            "required": required,
        },
    }


def _tools() -> Dict[str, Any]:
    return {"tools": [
        _schema("lookup_booking", "Look up the current hotel booking by current caller phone, or by booking number plus surname.", {
            "booking_number": {"type": "string"}, "surname": {"type": "string"},
        }, ["business_id", "caller_number"]),
        _schema("check_room_availability", "Check live Bnovo roomtype availability and exact daily tariff prices.", {
            "date_from": {"type": "string", "format": "date"},
            "date_to": {"type": "string", "format": "date"},
            "adults": {"type": "integer", "minimum": 1}, "children": {"type": "integer", "minimum": 0},
        }, ["business_id", "date_from", "date_to"]),
        _schema("get_booking_services", "Get safe service names and amounts for a booking already scoped to this hotel.", {
            "booking_id": {"type": "string"},
        }, ["business_id", "booking_id"]),
        _schema("create_booking_request", "Create a manager task for a new booking request. Does not mutate Bnovo.", {
            "name": {"type": "string"}, "date_from": {"type": "string", "format": "date"},
            "date_to": {"type": "string", "format": "date"}, "adults": {"type": "integer", "minimum": 1},
            "children": {"type": "integer", "minimum": 0}, "room_type_id": {"type": "string"},
            "room_type_name": {"type": "string"}, "tariff_id": {"type": "string"},
            "tariff_name": {"type": "string"}, "quoted_total": {"type": "number"},
            "currency": {"type": "string"}, "wishes": {"type": "string"},
        }, ["business_id", "call_id", "caller_number", "date_from", "date_to"]),
    ]}


def _call(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(args or {})
    payload["channel"] = "voice"
    if name == "lookup_booking":
        return _safe(
            "/api/ml/pms/lookup-booking",
            payload,
            _lookup_spoken,
            unavailable_spoken=(
                "Сейчас не удалось проверить бронь. Назовите номер бронирования и фамилию "
                "гостя либо попробуйте повторить проверку позже."
            ),
        )
    if name == "check_room_availability":
        return _safe(
            "/api/ml/pms/check-availability",
            payload,
            _availability_spoken,
            unavailable_spoken=(
                "Онлайн-проверка наличия и цены сейчас недоступна, поэтому я пока не могу "
                "подтвердить эти данные. Я продолжу отвечать на вопросы об отеле, а заявку "
                "на проверку оформлю только по вашему желанию."
            ),
        )
    if name == "get_booking_services":
        return _safe(
            "/api/ml/pms/booking-services",
            payload,
            lambda value: "Дополнительные услуги по брони получены.",
            unavailable_spoken=(
                "Сейчас не удалось получить услуги по брони. Попробуйте повторить проверку позже."
            ),
        )
    if name == "create_booking_request":
        return _safe(
            "/api/ml/pms/booking-request",
            payload,
            _request_spoken,
            unavailable_spoken="Заявка не создана из-за технической ошибки. Попробуем повторить попытку?",
        )
    raise ValueError(f"Unknown tool: {name}")


def main() -> int:
    buffer = bytearray()
    stdin = sys.stdin.buffer
    while True:
        chunk = stdin.read(1)
        if not chunk:
            return 0
        buffer.extend(chunk)
        while True:
            frame, consumed = decode_frame(buffer)
            if frame is None:
                break
            del buffer[:consumed]
            request_id = frame.get("id")
            method = frame.get("method")
            try:
                if method == "initialize":
                    result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "bnovo_pms", "version": "1.0.0"}}
                elif method == "tools/list":
                    result = _tools()
                elif method == "tools/call":
                    params = frame.get("params") or {}
                    result = _call(str(params.get("name") or ""), params.get("arguments") or {})
                elif method == "notifications/initialized":
                    continue
                else:
                    raise ValueError(f"Unsupported method: {method}")
                if request_id is not None:
                    sys.stdout.buffer.write(encode_message({"jsonrpc": "2.0", "id": request_id, "result": result}))
                    sys.stdout.buffer.flush()
            except Exception as error:
                if request_id is not None:
                    sys.stdout.buffer.write(encode_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(error)[:300]}}))
                    sys.stdout.buffer.flush()


if __name__ == "__main__":
    raise SystemExit(main())
