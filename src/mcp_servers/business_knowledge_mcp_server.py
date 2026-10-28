#!/usr/bin/env python3
"""Demo MCP server for voice-friendly business knowledge/RAG tools."""
from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, List, Optional

from src.mcp.stdio_framing import decode_frame, encode_message


_DOCS: List[Dict[str, Any]] = [
    {
        "document_id": "hotel_faq",
        "title": "Hotel guest FAQ",
        "chunks": [
            {
                "chunk_id": "checkin",
                "text": "Check-in starts at 15:00. Early check-in can be requested, but depends on room availability.",
            },
            {
                "chunk_id": "checkout",
                "text": "Check-out is until 12:00. Late check-out can be requested at reception and may have an extra fee.",
            },
            {
                "chunk_id": "parking",
                "text": "Guest parking is available near the main entrance. The daily parking fee is added to the room bill.",
            },
        ],
    },
    {
        "document_id": "hotel_services",
        "title": "Hotel services",
        "chunks": [
            {
                "chunk_id": "breakfast",
                "text": "Завтрак подается с 07:00 до 11:00 по будням и с 08:00 до 12:00 по выходным.",
            },
            {
                "chunk_id": "spa",
                "text": "The spa is open daily from 10:00 to 22:00. Guests should book treatments in advance.",
            },
            {
                "chunk_id": "pets",
                "text": "Small pets are allowed in selected rooms. The guest must notify the hotel before arrival.",
            },
        ],
    },
]

_ALIASES: Dict[str, List[str]] = {
    "завтрак": ["breakfast"],
    "завтрака": ["breakfast"],
    "завтраком": ["breakfast"],
    "breakfast": ["завтрак"],
    "бронь": ["booking"],
    "бронирование": ["booking"],
    "парковка": ["parking"],
    "парковки": ["parking"],
    "parking": ["парковка"],
    "спа": ["spa"],
    "spa": ["спа"],
    "питомцы": ["pets"],
    "животные": ["pets"],
    "pets": ["питомцы"],
    "заезд": ["checkin"],
    "checkin": ["заезд"],
    "выезд": ["checkout"],
    "checkout": ["выезд"],
}


def _write(payload: Dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_message(payload))
    sys.stdout.buffer.flush()


def _result(request_id: Any, result: Dict[str, Any]) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": int(code), "message": message}})


def _tokens(text: str) -> set[str]:
    base = {t for t in re.findall(r"[0-9A-Za-zА-Яа-яЁё]+", str(text).lower()) if len(t) > 2}
    expanded = set(base)
    for token in base:
        expanded.update(_ALIASES.get(token, []))
    return expanded


def _iter_chunks() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for doc in _DOCS:
        for chunk in doc["chunks"]:
            out.append(
                {
                    "document_id": doc["document_id"],
                    "title": doc["title"],
                    "chunk_id": chunk["chunk_id"],
                    "text": chunk["text"],
                }
            )
    return out


def search_business_docs(query: str, limit: int = 3, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    query_tokens = _tokens(query)
    doc_filter = str((filters or {}).get("document_id") or "").strip()
    scored: List[tuple[int, Dict[str, Any]]] = []
    for chunk in _iter_chunks():
        if doc_filter and chunk["document_id"] != doc_filter:
            continue
        score = len(query_tokens.intersection(_tokens(chunk["text"] + " " + chunk["title"] + " " + chunk["chunk_id"])))
        if score or not query_tokens:
            scored.append((score, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)
    matches = [chunk for _score, chunk in scored[: max(1, min(int(limit or 3), 5))]]
    if not matches:
        spoken = "I do not see that in the business knowledge base yet."
    else:
        spoken = matches[0]["text"]
    citations = [
        {"document_id": m["document_id"], "chunk_id": m["chunk_id"], "title": m["title"]}
        for m in matches
    ]
    return {
        "content": [{"type": "text", "text": spoken}],
        "structured": {
            "spoken": spoken,
            "citations": citations,
            "matches": [{"document_id": m["document_id"], "chunk_id": m["chunk_id"]} for m in matches],
        },
    }


def get_document_chunk(document_id: str, chunk_id: str) -> Dict[str, Any]:
    for chunk in _iter_chunks():
        if chunk["document_id"] == document_id and chunk["chunk_id"] == chunk_id:
            spoken = chunk["text"]
            return {
                "content": [{"type": "text", "text": spoken}],
                "structured": {
                    "spoken": spoken,
                    "citation": {
                        "document_id": chunk["document_id"],
                        "chunk_id": chunk["chunk_id"],
                        "title": chunk["title"],
                    },
                },
            }
    spoken = "I could not find that document chunk."
    return {"content": [{"type": "text", "text": spoken}], "structured": {"spoken": spoken}}


def answer_from_business_docs(question: str, caller_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    search_result = search_business_docs(question, limit=2, filters={})
    structured = search_result.get("structured", {})
    spoken = str(structured.get("spoken") or "I do not see that in the business knowledge base yet.")
    return {
        "content": [{"type": "text", "text": spoken}],
        "structured": {
            "spoken": spoken,
            "citations": structured.get("citations", []),
            "caller_context_used": bool(caller_context),
        },
    }


def _tools_list() -> Dict[str, Any]:
    return {
        "tools": [
            {
                "name": "search_business_docs",
                "description": "Search tenant business documents and return a short voice-safe answer with compact citations.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "query": {"type": "string", "description": "Search query or caller question."},
                        "limit": {"type": "integer", "description": "Maximum chunks to match, 1 to 5."},
                        "filters": {"type": "object", "description": "Optional metadata filters."},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "get_document_chunk",
                "description": "Fetch a single known document chunk by document_id and chunk_id.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "document_id": {"type": "string"},
                        "chunk_id": {"type": "string"},
                    },
                    "required": ["document_id", "chunk_id"],
                },
            },
            {
                "name": "answer_from_business_docs",
                "description": "Answer a caller question using business documents before using public web search.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "question": {"type": "string", "description": "Caller question."},
                        "caller_context": {"type": "object", "description": "Optional call/customer context."},
                    },
                    "required": ["question"],
                },
            },
        ]
    }


def _handle_call(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    if name == "search_business_docs":
        return search_business_docs(
            str(arguments.get("query") or ""),
            int(arguments.get("limit") or 3),
            arguments.get("filters") if isinstance(arguments.get("filters"), dict) else None,
        )
    if name == "get_document_chunk":
        return get_document_chunk(str(arguments.get("document_id") or ""), str(arguments.get("chunk_id") or ""))
    if name == "answer_from_business_docs":
        return answer_from_business_docs(
            str(arguments.get("question") or ""),
            arguments.get("caller_context") if isinstance(arguments.get("caller_context"), dict) else None,
        )
    return {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "structured": {"spoken": "Unknown tool."}}


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
                            "serverInfo": {"name": "business_knowledge", "version": "1.0.0"},
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
