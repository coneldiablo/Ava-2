#!/usr/bin/env python3
"""Opt-in direct Realtime protocol probe. Synthetic fixtures only; never dials SIP.

Default is offline plan. Credentials come exclusively from process environment.
Reports contain counts/booleans, never transcript, tool arguments, or credentials.
This probes the API, not AVA tenant routing, CRM durability, or caller acceptance.
"""
import argparse
import asyncio
import base64
import collections
import json
import os
import re
import time
import wave
from urllib.parse import urlencode


VOICES = {
    "sofia": {"casual", "support"}, "vera": {"casual", "support"},
    "vasily": {"support", "sales"}, "sergey": {"support", "sales"},
    "denis": {"casual", "formal", "neutral", "sales"},
    "irina": {"formal", "support", "narrator", "sales", "neutral"},
}


class ProbeFailure(RuntimeError):
    """Probe-owned failure codes; exception text is never reported."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def safe_server_error(value):
    """Only short machine identifiers; server prose and nested payloads are excluded."""
    if not isinstance(value, dict):
        return {}
    return {key: item for key in ("code", "type", "param")
            if isinstance((item := value.get(key)), str)
            and re.fullmatch(r"[a-z][a-z0-9_.]{0,63}", item)}


async def probe(args):
    report = {"scope": "direct_api_only", "phase": "credentials", "passed": False,
              "global_proxy_configured": bool(os.getenv("AI_PROVIDER_PROXY_URL")),
              "trust_env": False, "explicit_proxy": False, "events": collections.Counter(),
              "audio_bytes": 0, "transcript_received": False, "tool_executions": 0,
              "peer": None, "greeting_audio_received": False,
              "input_audio_received": False, "barge_speech_started": False,
              "barge_new_audio": False}
    started = time.monotonic()
    try:
        return await _probe(args, report)
    except Exception as exc:
        report.update(passed=False, error_class=type(exc).__name__,
                      failure_code=exc.code if isinstance(exc, ProbeFailure) else
                      ("timeout" if isinstance(exc, TimeoutError) else "unclassified"),
                      details="suppressed")
        return report
    finally:
        report["elapsed_ms"] = round((time.monotonic() - started) * 1000)
        report.pop("interrupted_response", None)


def pcm_fixture(path, rate):
    with wave.open(path, "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, rate, "NONE"):
            raise ValueError("fixture must be mono uncompressed PCM16 at selected rate")
        if not 1 <= wav.getnframes() / rate <= 20:
            raise ValueError("fixture duration must be 1..20 seconds")
        return wav.readframes(wav.getnframes())


def session_payload(voice, role, rate):
    if role not in VOICES.get(voice, set()):
        raise ValueError("unsupported LiveTTS voice/role")
    return {"type": "session.update", "session": {
        "type": "realtime", "output_modalities": ["audio"],
        "instructions": "Ты тестовый ассистент. Отвечай коротко на русском. Когда просят тестовый маркер, вызови acceptance_marker. Озвучь результат функции.",
        "audio": {"input": {"format": {"type": "audio/pcm", "rate": rate},
                            "turn_detection": {"type": "server_vad", "threshold": 0.5, "silence_duration_ms": 400}},
                  "output": {"format": {"type": "audio/pcm", "rate": rate}, "voice": voice, "role": role}},
        "tools": [{"type": "function", "name": "acceptance_marker", "description": "Получить синтетический тестовый маркер.",
                   "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}],
    }}


async def _probe(args, report):
    key, folder = os.getenv("YANDEX_CLOUD_API_KEY"), os.getenv("YANDEX_CLOUD_FOLDER_ID")
    if not key or not folder:
        raise ValueError("YANDEX_CLOUD_API_KEY and YANDEX_CLOUD_FOLDER_ID required")
    import aiohttp
    report["phase"] = "fixture"
    fixture = pcm_fixture(args.wav, args.rate) if args.wav else None
    url = "wss://ai.api.cloud.yandex.net/v1/realtime/openai?" + urlencode({"model": f"gpt://{folder}/speech-realtime-max-tts-live/latest"})
    started = time.monotonic()
    report["phase"] = "connect"
    async with aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=args.timeout)) as client:
        async with client.ws_connect(url, headers={"Authorization": f"Api-Key {key}"}, proxy=None, heartbeat=20) as ws:
            # Observed socket peer, with library-version-tolerant fallback. No URL/token logging.
            transport = getattr(getattr(ws, "_writer", None), "transport", None)
            if transport:
                peer = transport.get_extra_info("peername")
                report["peer"] = list(peer) if peer else None
            await ws.send_json(session_payload(args.voice, args.role, args.rate))
            seen_tools = set()
            phase = "setup"
            report["phase"] = phase
            upload = None
            response_id = None
            speech_generation = 0
            response_generations = {}
            response_audio = collections.Counter()
            function_response_ids = set()
            input_stopped_generation = 0

            async def text_turn(text):
                await ws.send_json({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}})
                await ws.send_json({"type": "response.create"})

            async def uplink():
                size = args.rate * 2 // 50  # 20 ms PCM chunks; preserve real-time VAD timing.
                data = fixture + bytes(args.rate * 2)  # one second trailing silence
                for offset in range(0, len(data), size):
                    await ws.send_json({"type": "input_audio_buffer.append", "audio": base64.b64encode(data[offset:offset+size]).decode()})
                    if offset + size >= len(fixture):
                        report["input_upload_complete"] = True
                    await asyncio.sleep(0.02)
                report["input_upload_finished"] = True

            try:
                async with asyncio.timeout(args.timeout):
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            raise ProbeFailure("unexpected_websocket_event")
                        event = json.loads(msg.data)
                        kind = event.get("type", "unknown")
                        # Count known protocol families only; arbitrary event names may contain data.
                        safe_kind = kind if kind in {
                            "session.created", "session.updated", "response.created", "response.done",
                            "response.output_audio.delta", "response.output_audio.done",
                            "response.output_audio_transcript.delta", "response.output_audio_transcript.done",
                            "response.output_text.delta", "response.output_text.done",
                            "response.output_item.added", "response.output_item.done",
                            "response.content_part.added", "response.content_part.done",
                            "response.function_call_arguments.delta", "response.function_call_arguments.done",
                            "conversation.item.created", "conversation.item.done",
                            "conversation.item.input_audio_transcription.completed",
                            "conversation.item.input_audio_transcription.delta",
                            "input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped",
                            "input_audio_buffer.committed", "error",
                        } else "unknown"
                        report["events"][safe_kind] += 1
                        if kind == "error":
                            report["server_error"] = safe_server_error(event.get("error"))
                            raise ProbeFailure("server_error")
                        if kind == "session.updated" and phase == "setup":
                            phase = "greeting"
                            report["phase"] = phase
                            await text_turn("Поздоровайся одной короткой фразой.")
                        elif kind == "response.created":
                            response_id = (event.get("response") or {}).get("id")
                            response_generations[response_id] = speech_generation
                            if phase == "barge" and report.get("barge_speech_started") and response_id != report.get("interrupted_response"):
                                report["barge_new_response"] = True
                        elif kind == "input_audio_buffer.speech_started":
                            speech_generation += 1
                            if phase == "audio":
                                report["input_speech_started_count"] = speech_generation
                            elif phase == "barge":
                                report["barge_speech_started"] = True
                        elif kind == "input_audio_buffer.speech_stopped":
                            input_stopped_generation = speech_generation
                            report["input_speech_stopped"] = True
                        elif kind == "response.output_audio.delta":
                            chunk_bytes = len(base64.b64decode(event["delta"], validate=True))
                            report["audio_bytes"] += chunk_bytes
                            response_audio[event.get("response_id") or response_id] += chunk_bytes
                            report.setdefault("first_audio_ms", round((time.monotonic()-started)*1000))
                            if phase == "barge_prompt":
                                phase = "barge"
                                report["phase"] = phase
                                report["interrupted_response"] = response_id
                                report["input_upload_complete"] = False
                                report["input_upload_finished"] = False
                                upload = asyncio.create_task(uplink())
                            elif phase == "barge" and report.get("barge_new_response") and event.get("response_id") == response_id:
                                report["barge_new_audio"] = True
                        elif kind == "conversation.item.input_audio_transcription.completed":
                            report["transcript_received"] |= bool(event.get("transcript"))
                        elif kind == "response.output_item.done":
                            item = event.get("item") or {}
                            if item.get("type") == "function_call":
                                function_response_ids.add(event.get("response_id") or response_id)
                                call_id = item.get("call_id")
                                if item.get("name") != "acceptance_marker" or not call_id or json.loads(item.get("arguments") or "{}") != {}:
                                    raise ProbeFailure("unexpected_tool")
                                if call_id not in seen_tools:
                                    seen_tools.add(call_id)
                                    report["tool_executions"] += 1
                                    await ws.send_json({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": call_id, "output": '{"marker":"synthetic-ok"}'}})
                                    await ws.send_json({"type": "response.create"})
                        elif kind == "response.done":
                            status = (event.get("response") or {}).get("status")
                            done_id = (event.get("response") or {}).get("id") or response_id
                            if status in {"failed", "incomplete"} or (status == "cancelled" and phase not in {"audio", "barge"}):
                                report["response_status"] = status
                                report["server_error"] = safe_server_error(((event.get("response") or {}).get("status_details") or {}).get("error"))
                                raise ProbeFailure("response_failed")
                            if status == "cancelled":
                                report["cancelled_responses"] = report.get("cancelled_responses", 0) + 1
                                continue
                            if status != "completed":
                                continue
                            # A completed function-call response is an intermediate
                            # turn. Its matching output has been sent above; the
                            # response.create continuation must still supply audio.
                            if done_id in function_response_ids and not response_audio[done_id]:
                                report["function_responses_awaiting_continuation"] = report.get("function_responses_awaiting_continuation", 0) + 1
                                continue
                            if phase == "greeting":
                                report["greeting_audio_bytes"] = report["audio_bytes"]
                                report["greeting_audio_received"] = bool(report["audio_bytes"])
                                if fixture:
                                    phase = "audio"
                                    report["phase"] = phase
                                    upload = asyncio.create_task(uplink())
                                else:
                                    phase = "tool"
                                    report["phase"] = phase
                                    report["tool_count_start"] = report["tool_executions"]
                                    await text_turn("Получи тестовый маркер через acceptance_marker.")
                            elif phase == "audio":
                                # Ignore answers superseded by a later VAD speech segment.
                                # Do not block receive on upload: later speech/transcript events must be processed.
                                if (not report.get("input_upload_complete") or
                                        done_id != response_id or not speech_generation or
                                        response_generations.get(done_id) != speech_generation or
                                        input_stopped_generation != speech_generation):
                                    report["superseded_answers"] = report.get("superseded_answers", 0) + 1
                                    continue
                                if upload and upload.done():
                                    await upload
                                report["final_input_response_completed"] = True
                                report["input_turn_audio_bytes"] = response_audio[done_id]
                                report["input_audio_received"] = bool(report["input_turn_audio_bytes"])
                                if not report["transcript_received"] or not report["input_turn_audio_bytes"]:
                                    raise ProbeFailure("input_turn_incomplete")
                                phase = "tool"
                                report["phase"] = phase
                                report["tool_audio_start"] = report["audio_bytes"]
                                report["tool_count_start"] = report["tool_executions"]
                                await text_turn("Получи тестовый маркер через acceptance_marker.")
                            elif phase == "tool" and report["tool_executions"] > report.get("tool_count_start", 0) and report["audio_bytes"] > report.get("tool_audio_start", report.get("greeting_audio_bytes", 0)):
                                report["tool_continuation_audio"] = True
                                if fixture:
                                    phase = "barge_prompt"
                                    report["phase"] = phase
                                    await text_turn("Расскажи длинную историю о путешествии, минимум тридцать предложений, без инструментов.")
                                else:
                                    report["passed"] = bool(report["greeting_audio_bytes"])
                                    return report
                            elif phase == "barge" and report.get("barge_speech_started") and report.get("barge_new_audio"):
                                if upload:
                                    await upload
                                report["passed"] = bool(report["greeting_audio_bytes"] and report["transcript_received"])
                                report.pop("interrupted_response", None)
                                return report
            finally:
                if upload and not upload.done():
                    upload.cancel()
                    await asyncio.gather(upload, return_exceptions=True)
    raise ProbeFailure("session_closed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="explicitly authorize metered API probe; never originates a call")
    parser.add_argument("--voice", default="sofia")
    parser.add_argument("--role", default="support")
    parser.add_argument("--rate", type=int, default=24000)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--wav", help="synthetic spoken question, mono PCM16; also injected during output to test server barge-in")
    args = parser.parse_args()
    session_payload(args.voice, args.role, args.rate)
    if not args.live:
        print(json.dumps({"live": False, "model": "speech-realtime-max-tts-live/latest", "voice": args.voice, "role": args.role, "rate": args.rate, "scope": "direct_api_only", "checks": ["session.updated", "greeting audio", "function result audio", "input transcript and server barge-in if --wav"], "pending": ["AVA tenant tools", "AVA playback queue flush", "CRM durable save", "fallback", "local Asterisk"]}))
        return
    try:
        report = asyncio.run(probe(args))
        print(json.dumps(report, sort_keys=True))
        if not report["passed"]:
            raise SystemExit(1)
    except Exception as exc:
        # Exception strings may contain authenticated URLs, headers, or server text.
        print(json.dumps({"passed": False, "error_class": type(exc).__name__, "details": "suppressed"}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
