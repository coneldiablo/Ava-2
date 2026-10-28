import base64

import pytest

from src.config import GoogleProviderConfig
from src.providers.google_live import (
    GoogleLiveProvider,
    _GOOGLE_LIVE_FIRST_AUDIO_FORWARD,
    _GOOGLE_LIVE_LAST_TRANSCRIPT_TO_AUDIO,
)


class RecordingSession:
    def __init__(self):
        self.conversation_history = []
        self.turn_latencies_ms = []


class RecordingStore:
    def __init__(self, order):
        self.order = order
        self.session = RecordingSession()

    async def get_by_call_id(self, _call_id):
        self.order.append("read_history")
        return self.session

    async def upsert_call(self, _session):
        self.order.append("save_history")


def _count(histogram):
    return next(sample.value for sample in histogram.collect()[0].samples if sample.name.endswith("_count"))


@pytest.mark.asyncio
@pytest.mark.unit
async def test_google_live_forwards_first_audio_before_saving_turn_history():
    order = []

    async def on_event(event):
        order.append(event["type"])

    provider = GoogleLiveProvider(GoogleProviderConfig(), on_event=on_event)
    provider._call_id = "call-1"
    provider._session_store = RecordingStore(order)
    before_audio = _count(_GOOGLE_LIVE_LAST_TRANSCRIPT_TO_AUDIO)
    before_forward = _count(_GOOGLE_LIVE_FIRST_AUDIO_FORWARD)

    # Gemini may put transcription, first audio and turnComplete in one envelope.
    # The history write must not delay the first playable audio in that case.
    await provider._handle_server_content(
        {
            "serverContent": {
                "inputTranscription": {"text": "What time is checkout?"},
                "outputTranscription": {"text": "Checkout is at noon."},
                "modelTurn": {
                    "parts": [{
                        "inlineData": {
                            "mimeType": "audio/pcm;rate=24000",
                            "data": base64.b64encode(b"\x00\x00" * 480).decode(),
                        }
                    }]
                },
                "turnComplete": True,
            }
        }
    )

    assert order[0] == "AgentAudio"
    assert order.index("AgentAudio") < order.index("read_history")
    assert order[-1] == "AgentAudioDone"
    assert provider._session_store.session.turn_latencies_ms
    assert [entry["role"] for entry in provider._session_store.session.conversation_history] == [
        "user", "assistant"
    ]
    assert _count(_GOOGLE_LIVE_LAST_TRANSCRIPT_TO_AUDIO) == before_audio + 1
    assert _count(_GOOGLE_LIVE_FIRST_AUDIO_FORWARD) == before_forward + 1


@pytest.mark.asyncio
@pytest.mark.unit
async def test_google_live_keeps_model_text_fallback_when_turn_completes_with_audio():
    order = []

    async def on_event(event):
        order.append(event["type"])

    provider = GoogleLiveProvider(GoogleProviderConfig(), on_event=on_event)
    provider._call_id = "call-2"
    provider._session_store = RecordingStore(order)

    await provider._handle_server_content(
        {"serverContent": {
            "modelTurn": {"parts": [{"text": "Fallback answer"}]},
            "turnComplete": True,
        }}
    )

    assert provider._session_store.session.conversation_history[-1]["content"] == "Fallback answer"
