#!/usr/bin/env python3
"""Demo MCP server for hotel PMS/CRM-style tools."""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.mcp.stdio_framing import decode_frame, encode_message


_GUESTS: Dict[str, Dict[str, Any]] = {
    "6000": {
        "guest_id": "guest_6000",
        "name": "Test Guest 6000",
        "phone": "6000",
        "vip": True,
        "language": "ru",
    },
    "6002": {
        "guest_id": "guest_6002",
        "name": "Test Guest 6002",
        "phone": "6002",
        "vip": False,
        "language": "ru",
    },
}

_BOOKINGS: Dict[str, Dict[str, Any]] = {
    "guest_6000": {
        "booking_id": "BK-6000",
        "status": "confirmed",
        "arrival_date": "2026-05-02",
        "departure_date": "2026-05-05",
        "room_type": "Deluxe King",
        "guests": 2,
    },
    "guest_6002": {
        "booking_id": "BK-6002",
        "status": "pending",
        "arrival_date": "2026-05-03",
        "departure_date": "2026-05-04",
        "room_type": "Standard Twin",
        "guests": 1,
    },
}

_CRM_NOTES: List[Dict[str, Any]] = []


def _data_dir() -> Path:
    return Path(os.getenv("AVA_DEMO_DATA_DIR", "/app/data/demo_tools"))


def _append_jsonl(filename: str, payload: Dict[str, Any]) -> None:
    path = _data_dir() / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")


def _read_jsonl(filename: str, limit: int = 5) -> List[Dict[str, Any]]:
    path = _data_dir() / filename
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                rows.append(item)
    safe_limit = max(1, min(int(limit or 5), 20))
    return rows[-safe_limit:]


def _write(payload: Dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_message(payload))
    sys.stdout.buffer.flush()


def _result(request_id: Any, result: Dict[str, Any]) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": int(code), "message": message}})


def _digits(value: str) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _voice_result(spoken: str, **structured: Any) -> Dict[str, Any]:
    data = {"spoken": spoken}
    data.update(structured)
    return {"content": [{"type": "text", "text": spoken}], "structured": data}


def lookup_guest_by_phone(phone: str) -> Dict[str, Any]:
    key = _digits(phone)
    guest = _GUESTS.get(key)
    if not guest:
        spoken = "I did not find this guest by phone. I can create a new lead or ask for the booking number."
        return _voice_result(spoken, found=False)
    spoken = f"I found {guest['name']}. VIP status is {'yes' if guest.get('vip') else 'no'}."
    return _voice_result(spoken, found=True, guest=guest)


def lookup_booking(phone: str = "", name: str = "", booking_id: str = "") -> Dict[str, Any]:
    guest: Optional[Dict[str, Any]] = None
    if phone:
        guest = _GUESTS.get(_digits(phone))
    if not guest and name:
        name_l = str(name).lower()
        for item in _GUESTS.values():
            if name_l in str(item.get("name", "")).lower():
                guest = item
                break
    booking: Optional[Dict[str, Any]] = None
    if booking_id:
        booking_id_clean = str(booking_id).strip()
        booking_digits = _digits(booking_id_clean)
        for item in _BOOKINGS.values():
            candidate = str(item.get("booking_id", "")).lower()
            if candidate == booking_id_clean.lower() or (
                booking_digits and candidate == f"bk-{booking_digits}".lower()
            ):
                booking = item
                break
        if not guest and booking_digits:
            guest = _GUESTS.get(booking_digits)
    if not booking and guest:
        booking = _BOOKINGS.get(str(guest.get("guest_id")))
    if not booking:
        spoken = "I could not find a booking. I can create a front desk task for a human follow-up."
        return _voice_result(spoken, found=False)
    status_label = "подтверждена" if booking.get("status") == "confirmed" else str(booking.get("status") or "найдена")
    spoken = (
        f"Бронь {booking['booking_id']} {status_label}: "
        f"с {booking['arrival_date']} по {booking['departure_date']}, "
        f"номер {booking['room_type']}, гостей {booking['guests']}."
    )
    return _voice_result(spoken, found=True, booking=booking, guest=guest)


def check_room_availability(
    arrival_date: str,
    departure_date: str,
    guests: int = 1,
    room_type: str = "",
) -> Dict[str, Any]:
    room_label = room_type or "Standard"
    options = [
        {
            "room_type": room_label,
            "available": True,
            "nightly_rate": 120,
            "currency": "EUR",
        },
        {
            "room_type": "Deluxe King",
            "available": True,
            "nightly_rate": 180,
            "currency": "EUR",
        },
    ]
    spoken = (
        f"I found availability from {arrival_date} to {departure_date}. "
        f"The best option is {options[0]['room_type']} at {options[0]['nightly_rate']} euros per night."
    )
    return _voice_result(spoken, arrival_date=arrival_date, departure_date=departure_date, guests=guests, options=options)


def create_booking_request(
    guest: Dict[str, Any],
    arrival_date: str,
    departure_date: str,
    preferences: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    request_id = f"REQ-{int(time.time())}"
    name = str((guest or {}).get("name") or "the guest")
    spoken = f"I created booking request {request_id} for {name}. The front desk can confirm final availability."
    return _voice_result(
        spoken,
        request_id=request_id,
        guest=guest or {},
        arrival_date=arrival_date,
        departure_date=departure_date,
        preferences=preferences or {},
        confirmation_required=False,
    )


def create_frontdesk_task(guest: Dict[str, Any], topic: str, summary: str) -> Dict[str, Any]:
    task_id = f"TASK-{int(time.time())}"
    name = str((guest or {}).get("name") or "the caller")
    task = {
        "task_id": task_id,
        "created_at": int(time.time()),
        "guest": guest or {},
        "topic": topic,
        "summary": summary,
        "status": "open",
    }
    _append_jsonl("frontdesk_tasks.jsonl", task)
    spoken = f"I created front desk task {task_id} for {name}: {topic}."
    return _voice_result(spoken, task_id=task_id, guest=guest or {}, topic=topic, summary=summary, task=task)


def list_frontdesk_tasks(limit: int = 5) -> Dict[str, Any]:
    tasks = _read_jsonl("frontdesk_tasks.jsonl", limit=limit)
    if not tasks:
        return _voice_result("There are no demo front desk tasks yet.", tasks=[])
    latest = tasks[-1]
    spoken = f"Latest front desk task is {latest.get('task_id')}: {latest.get('topic')}."
    return _voice_result(spoken, tasks=tasks)


def handoff_to_frontdesk(reason: str) -> Dict[str, Any]:
    spoken = "I will hand this to the front desk. One moment please."
    return _voice_result(
        spoken,
        transfer_required=True,
        destination_extension="6002",
        reason=reason,
    )


def crm_add_call_note(contact_id: str, summary: str, outcome: str = "completed") -> Dict[str, Any]:
    note_id = f"NOTE-{int(time.time())}-{len(_CRM_NOTES) + 1}"
    note = {
        "note_id": note_id,
        "created_at": int(time.time()),
        "contact_id": contact_id,
        "summary": summary,
        "outcome": outcome,
    }
    _CRM_NOTES.append(note)
    _append_jsonl("crm_notes.jsonl", note)
    spoken = f"I saved the CRM note {note_id}."
    return _voice_result(spoken, note=note)


def list_crm_notes(limit: int = 5) -> Dict[str, Any]:
    notes = _read_jsonl("crm_notes.jsonl", limit=limit)
    if not notes:
        return _voice_result("There are no demo CRM notes yet.", notes=[])
    latest = notes[-1]
    spoken = f"Latest CRM note is {latest.get('note_id')} for {latest.get('contact_id')}."
    return _voice_result(spoken, notes=notes)


def _tools_list() -> Dict[str, Any]:
    return {
        "tools": [
            {
                "name": "lookup_guest_by_phone",
                "description": "Look up a hotel guest profile by caller phone or extension.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"phone": {"type": "string"}},
                    "required": ["phone"],
                },
            },
            {
                "name": "lookup_booking",
                "description": "Find a hotel booking by phone, guest name, or booking id.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "phone": {"type": "string"},
                        "name": {"type": "string"},
                        "booking_id": {"type": "string"},
                    },
                },
            },
            {
                "name": "check_room_availability",
                "description": "Check demo hotel room availability for dates, guest count, and room type.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "arrival_date": {"type": "string", "description": "YYYY-MM-DD"},
                        "departure_date": {"type": "string", "description": "YYYY-MM-DD"},
                        "guests": {"type": "integer"},
                        "room_type": {"type": "string"},
                    },
                    "required": ["arrival_date", "departure_date"],
                },
            },
            {
                "name": "create_booking_request",
                "description": "Create a safe demo booking request; does not directly modify a real PMS booking.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "guest": {"type": "object"},
                        "arrival_date": {"type": "string"},
                        "departure_date": {"type": "string"},
                        "preferences": {"type": "object"},
                    },
                    "required": ["guest", "arrival_date", "departure_date"],
                },
            },
            {
                "name": "create_frontdesk_task",
                "description": "Create a task for the front desk when the AI should not perform a risky write.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "guest": {"type": "object"},
                        "topic": {"type": "string"},
                        "summary": {"type": "string"},
                    },
                    "required": ["topic", "summary"],
                },
            },
            {
                "name": "handoff_to_frontdesk",
                "description": "Prepare a caller handoff to the front desk without changing telephony config.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"reason": {"type": "string"}},
                    "required": ["reason"],
                },
            },
            {
                "name": "list_frontdesk_tasks",
                "description": "List recently created demo front desk tasks for verification.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"limit": {"type": "integer"}},
                },
            },
            {
                "name": "crm_add_call_note",
                "description": "Save a demo CRM call note after a call or important conversation step.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "contact_id": {"type": "string"},
                        "summary": {"type": "string"},
                        "outcome": {"type": "string"},
                    },
                    "required": ["contact_id", "summary"],
                },
            },
            {
                "name": "list_crm_notes",
                "description": "List recently saved demo CRM notes for verification.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"limit": {"type": "integer"}},
                },
            },
        ]
    }


def _handle_call(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    args = arguments or {}
    if name == "lookup_guest_by_phone":
        return lookup_guest_by_phone(str(args.get("phone") or ""))
    if name == "lookup_booking":
        return lookup_booking(str(args.get("phone") or ""), str(args.get("name") or ""), str(args.get("booking_id") or ""))
    if name == "check_room_availability":
        return check_room_availability(
            str(args.get("arrival_date") or ""),
            str(args.get("departure_date") or ""),
            int(args.get("guests") or 1),
            str(args.get("room_type") or ""),
        )
    if name == "create_booking_request":
        return create_booking_request(
            args.get("guest") if isinstance(args.get("guest"), dict) else {},
            str(args.get("arrival_date") or ""),
            str(args.get("departure_date") or ""),
            args.get("preferences") if isinstance(args.get("preferences"), dict) else None,
        )
    if name == "create_frontdesk_task":
        return create_frontdesk_task(
            args.get("guest") if isinstance(args.get("guest"), dict) else {},
            str(args.get("topic") or ""),
            str(args.get("summary") or ""),
        )
    if name == "handoff_to_frontdesk":
        return handoff_to_frontdesk(str(args.get("reason") or ""))
    if name == "list_frontdesk_tasks":
        return list_frontdesk_tasks(int(args.get("limit") or 5))
    if name == "crm_add_call_note":
        return crm_add_call_note(str(args.get("contact_id") or ""), str(args.get("summary") or ""), str(args.get("outcome") or "completed"))
    if name == "list_crm_notes":
        return list_crm_notes(int(args.get("limit") or 5))
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
                            "serverInfo": {"name": "hotel_demo", "version": "1.0.0"},
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
