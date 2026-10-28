"""Exercise saved business choices through real engine call setup, without audio IO."""
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.config import NeuroGeminiProviderConfig, GoogleProviderConfig
from src.core.models import CallSession
from src.core.transport_orchestrator import ContextConfig, TransportProfile
from src.engine import Engine


def profile(business, model="gemini-3.8-flash", voice="edsel", provider="neuro_gemini"):
    return {"id": business, "businessId": business, "voiceAiProvider": provider,
            "voiceModel": model, "voiceName": voice,
            "voiceSettings": {provider: {"model": model, "voiceName": voice}},
            "systemPrompt": f"Instructions for business {business}",
            "voiceContextName": f"business-{business}",
            "voiceGreetingTemplate": f"Welcome business {business}",
            "outboundOpenerTemplate": f"Calling from business {business}"}


def engine_for_calls(saved):
    e = object.__new__(Engine)
    created = []
    stored = {}
    e.providers = {"neuro_gemini": SimpleNamespace(config=NeuroGeminiProviderConfig())}
    e._call_providers = {}
    e._hotel_profile_cache = {}
    e._hotel_profile_cache_ttl_seconds = 30
    e._fetch_hotel_profile = AsyncMock(side_effect=lambda business: copy.deepcopy(saved[business]))
    e._hotel_profile_base_url = lambda: "https://crm.invalid"
    e._hotel_profile_service_token = lambda: "test-service-token"
    e._context_business_id = lambda name: None
    e._business_id_from_sip_alias = lambda number: None
    e._resolve_business_id = lambda **kwargs: int(kwargs["channel_vars"]["AAVA_BUSINESS_ID"])
    e.config = SimpleNamespace(default_provider="google_live", audio_transport="audiosocket",
                               audiosocket=SimpleNamespace(format="ulaw"), dict=lambda: {}, tools={})
    e.pipeline_orchestrator = SimpleNamespace(enabled=False)
    e.conversation_coordinator = None
    e.streaming_playback_manager = SimpleNamespace()
    e._execute_pre_call_tools = AsyncMock(return_value={})
    e._cleanup_call = AsyncMock()

    async def channel_value(method, url, params, **kwargs):
        business = url.split("/")[1].split("-")[0]
        values = {"AAVA_BUSINESS_ID": business, "AI_CONTEXT": f"business-{business}"}
        return {"value": values.get(params["variable"], "")}

    e.ari_client = SimpleNamespace(send_command=AsyncMock(side_effect=channel_value), hangup_channel=AsyncMock())

    def context(name):
        return ContextConfig(prompt="Trusted tenant context", greeting="Context greeting", tools=["hangup_call"])

    def transport(**kwargs):
        return TransportProfile("phone", "ulaw", 8000, "linear16", 16000, "linear16", 16000, 16000, 20, 1200,
                                context=kwargs["channel_vars"].get("AI_CONTEXT"))

    e.transport_orchestrator = SimpleNamespace(get_context_config=context, resolve_transport=transport)

    async def save(call, **kwargs):
        stored[call.call_id] = call

    e._save_session = save
    e.session_store = SimpleNamespace(get_by_call_id=AsyncMock(side_effect=lambda call: stored[call]), upsert_call=AsyncMock())

    def factory():
        p = SimpleNamespace(config=NeuroGeminiProviderConfig(instructions="Global unchanged"),
                            start_session=AsyncMock(), stop_session=AsyncMock(), set_input_mode=Mock())
        created.append(p)
        return p

    e.provider_factories = {"neuro_gemini": factory}
    return e, created, stored


@pytest.mark.asyncio
async def test_fresh_saved_choices_two_businesses_and_unchanged_active_call(monkeypatch):
    saved = {7: profile(7), 8: profile(8, "gemini-3.7-flash", "another-voice")}
    e, created, stored = engine_for_calls(saved)
    e._hotel_profile_cache[7] = (10**12, profile(7, "gemini-3.7-flash", "stale-voice"))
    from src.tools.registry import tool_registry
    monkeypatch.setattr(tool_registry, "get_tools_for_context", lambda *args, **kwargs: [SimpleNamespace(definition=SimpleNamespace(name="hangup_call"))])

    async def start(business, suffix, outbound=False):
        call = CallSession(call_id=f"{business}-{suffix}", caller_channel_id=f"{business}-{suffix}", caller_name=f"Caller {business}", caller_number=f"{business}000")
        call.is_outbound = outbound
        await e._resolve_audio_profile(call, call.call_id)
        await e._start_provider_session(call.call_id)
        assert call.provider_session_active
        return call, created[-1]

    first, first_provider = await start(7, "a")
    second, second_provider = await start(8, "a", outbound=True)
    assert (first_provider.config.model, first_provider.config.voice_name) == ("gemini-3.8-flash", "edsel")
    assert (second_provider.config.model, second_provider.config.voice_name) == ("gemini-3.7-flash", "another-voice")
    assert first_provider.config.target_encoding == "ulaw" and first_provider.config.target_sample_rate_hz == 8000
    for call, provider in ((first, first_provider), (second, second_provider)):
        context = provider.start_session.call_args.kwargs["context"]
        assert context["business_id"] == call.business_id
        assert context["caller_name"] == f"Caller {call.business_id}"
        assert context["caller_id"] == f"{call.business_id}000"
        assert context["tools"] == ["hangup_call"]
        assert "Trusted tenant context" in context["prompt"]
        assert f"Instructions for business {call.business_id}" in context["prompt"]
        assert f"Instructions for business {15-call.business_id}" not in context["prompt"]
        assert context["call_direction"] == ("outbound" if call.is_outbound else "inbound")
        assert provider._business_id == call.business_id
        assert provider._session_store is e.session_store and provider._ari_client is e.ari_client
        provider.set_input_mode.assert_called_once_with("mulaw8k")
    assert first_provider.config.greeting == "Welcome business 7"
    assert second_provider.config.greeting == "Calling from business 8"

    saved[7] = profile(7, "gemini-3.7-flash", "updated-voice")
    third, third_provider = await start(7, "b")
    assert (third_provider.config.model, third_provider.config.voice_name) == ("gemini-3.7-flash", "updated-voice")
    assert (first_provider.config.model, first_provider.config.voice_name) == ("gemini-3.8-flash", "edsel")
    # Even a later mutation of a cached/readback dictionary cannot rewrite the call snapshot.
    first.hotel_profile["voiceSettings"]["neuro_gemini"]["voiceName"] = "mutable-readback"
    assert e._business_voice_selection(first)["voice_name"] == "edsel"
    assert e._business_voice_selection(third)["voice_name"] == "updated-voice"
    assert e.providers["neuro_gemini"].config.voice_name == "edsel"
    assert e._fetch_hotel_profile.await_count == 3
    before = first_provider.start_session.await_count
    await e._start_provider_session(first.call_id)
    assert first_provider.start_session.await_count == before
    assert stored[first.call_id].provider_name == "neuro_gemini"


def test_provider_switch_uses_own_saved_settings_and_returns_without_leakage():
    saved = profile(7)
    saved["voiceSettings"]["google_live"] = {"model": "gemini-live-saved", "voiceName": "Aoede"}
    e, _, _ = engine_for_calls({7: saved})
    call = CallSession("7-a", "7-a", business_id=7, hotel_profile=saved)
    e._snapshot_business_voice_settings(call)
    call.provider_overrides.update(voice_name="foreign-voice", voice_model="foreign-model")
    call.provider_name = "google_live"
    google = SimpleNamespace(config=GoogleProviderConfig())
    e._apply_provider_overrides(google, call)
    assert (google.config.llm_model, google.config.tts_voice_name) == ("gemini-live-saved", "Aoede")
    call.provider_name = "neuro_gemini"
    neuro = SimpleNamespace(config=NeuroGeminiProviderConfig())
    e._apply_provider_overrides(neuro, call)
    assert (neuro.config.model, neuro.config.voice_name) == ("gemini-3.8-flash", "edsel")
    call.provider_name = "openai_realtime"
    selection = e._business_voice_selection(call)
    assert selection == {"voice_model": "", "voice_name": ""}


@pytest.mark.asyncio
async def test_waiting_settings_reach_the_call_as_an_immutable_business_snapshot(monkeypatch):
    saved = {7: profile(7), 8: profile(8)}
    custom = {"enabled": False, "phrases": ["Проверяю наличие."], "afterSeconds": 4, "repeatSeconds": 20, "maxMessages": 1}
    saved[7]["voiceWaiting"] = copy.deepcopy(custom)
    saved[8]["voiceWaiting"] = {**custom, "enabled": True, "phrases": ["Уточняю детали."]}
    e, created, _ = engine_for_calls(saved)
    from src.tools.registry import tool_registry
    monkeypatch.setattr(tool_registry, "get_tools_for_context", lambda *args, **kwargs: [])
    for business in (7, 8):
        call = CallSession(call_id=f"{business}-waiting", caller_channel_id=f"{business}-waiting", caller_number=f"{business}000")
        await e._resolve_audio_profile(call, call.call_id)
        await e._start_provider_session(call.call_id)
        assert created[-1].start_session.call_args.kwargs["context"]["progress"] == saved[business]["voiceWaiting"]
    first = created[0].start_session.call_args.kwargs["context"]["progress"]
    saved[7]["voiceWaiting"]["phrases"][0] = "Changed later"
    assert first == custom


@pytest.mark.parametrize('patch', [{"enabled": "false"}, {"phrases": ["unsafe\nline"]}, {"afterSeconds": True}, {"maxMessages": 1.5}])
def test_invalid_waiting_profile_cannot_override_runtime(patch):
    value = {"enabled": True, "phrases": ["Проверяю."], "afterSeconds": 3, "repeatSeconds": 15, "maxMessages": 1}
    assert Engine._normalize_voice_waiting({**value, **patch}) is None


@pytest.mark.asyncio
async def test_unavailable_canonical_profile_terminates_without_default_fallback():
    e, created, _ = engine_for_calls({7: profile(7)})
    e._fetch_hotel_profile.return_value = None
    e._fetch_hotel_profile.side_effect = None
    e.provider_factories["google_live"] = lambda: pytest.fail("Silent fallback attempted")
    e.on_provider_event = AsyncMock()
    call = CallSession("7-fail", "7-fail")
    await e._resolve_audio_profile(call, call.call_id)
    await e._start_provider_session(call.call_id)
    assert call.error_message == "voice_provider_startup_failed"
    assert not call.provider_session_active and not created
    e._execute_pre_call_tools.assert_not_awaited()
    e._cleanup_call.assert_awaited_once_with(call.call_id)


@pytest.mark.asyncio
async def test_known_selection_outage_without_service_env_keeps_cache_and_fails():
    saved = profile(7)
    e, _, _ = engine_for_calls({7: saved})
    e._hotel_profile_base_url = lambda: ""
    e._hotel_profile_cache[7] = (10**12, copy.deepcopy(saved))
    e._fetch_hotel_profile.side_effect = None
    e._fetch_hotel_profile.return_value = None
    with pytest.raises(RuntimeError, match="business_voice_settings_unavailable"):
        await e._resolve_hotel_profile(7, fresh=True)
    assert e._hotel_profile_cache[7][1] == saved


@pytest.mark.asyncio
@pytest.mark.parametrize("foreign", [{"id": 8, "voiceAiProvider": "neuro_gemini"}, {"voiceAiProvider": "neuro_gemini"}])
async def test_fresh_lookup_rejects_foreign_or_unidentified_profile(foreign):
    e, _, _ = engine_for_calls({7: foreign})
    with pytest.raises(RuntimeError, match="business_voice_settings_unavailable"):
        await e._resolve_hotel_profile(7, fresh=True)


def test_neuro_dictionary_config_receives_exact_model_and_voice_keys():
    e, _, _ = engine_for_calls({7: profile(7)})
    call = CallSession("7-dict", "7-dict", business_id=7, provider_name="neuro_gemini", hotel_profile=profile(7, "gemini-3.7-flash", "vlad"))
    provider = SimpleNamespace(config={"model": "gemini-3.8-flash", "voice_name": "edsel"})
    e._apply_provider_overrides(provider, call)
    assert provider.config["model"] == "gemini-3.7-flash"
    assert provider.config["voice_name"] == "vlad"


@pytest.mark.parametrize("model", ["unsupported", "gemini-3.7-flash"])
def test_unsupported_or_disabled_model_fails_explicitly(monkeypatch, model):
    e, _, _ = engine_for_calls({7: profile(7)})
    call = CallSession("7-invalid", "7-invalid", business_id=7, provider_name="neuro_gemini", hotel_profile=profile(7, model))
    monkeypatch.setenv("NEURO_GEMINI_MODELS", "gemini-3.8-flash")
    with pytest.raises(ValueError):
        e._apply_provider_overrides(SimpleNamespace(config=NeuroGeminiProviderConfig()), call)


@pytest.mark.asyncio
async def test_factory_registration_requires_environment_key_and_creates_separate_configs(monkeypatch):
    e, _, _ = engine_for_calls({})
    e.config.providers = {"neuro_gemini": {"api_key": "yaml-key"}}
    e.config.default_provider = "neuro_gemini"
    e.config.pipelines = {}
    e.provider_alignment_issues = {}
    e._audit_provider_config = lambda *args: []
    e._describe_provider_alignment = lambda *args: []
    e.on_provider_event = AsyncMock()
    e.audio_gating_manager = None
    monkeypatch.delenv("NEURO_GEMINI_MODELS", raising=False)
    monkeypatch.delenv("NEURO_API_KEY", raising=False)
    await e._load_providers()
    assert not e.providers and not e.provider_factories
    monkeypatch.setenv("NEURO_API_KEY", "test-env-key")
    await e._load_providers()
    assert "neuro_gemini" in e.providers
    a, b = e.provider_factories["neuro_gemini"](), e.provider_factories["neuro_gemini"]()
    a.config.voice_name = "tenant-voice"
    assert b.config.voice_name == e.providers["neuro_gemini"].config.voice_name == "edsel"
    assert a.config.api_key == "test-env-key"
    monkeypatch.setenv("NEURO_GEMINI_MODELS", "gemini-3.7-flash")
    await e._load_providers()
    assert e.providers["neuro_gemini"].config.model == "gemini-3.7-flash"
    assert e.provider_factories["neuro_gemini"]().config.model == "gemini-3.7-flash"
    monkeypatch.setenv("NEURO_GEMINI_MODELS", "")
    await e._load_providers()
    assert e.providers["neuro_gemini"].config.model == "gemini-3.8-flash"


@pytest.mark.asyncio
@pytest.mark.parametrize("outbound", [False, True])
async def test_managed_admission_holds_own_profile_across_cache_overwrite(monkeypatch, outbound):
    from src.core.managed_telephony import ManagedTelephony
    saved = {7: profile(7)}
    e, _, _ = engine_for_calls(saved)
    e.session_store.get_by_call_id = AsyncMock(return_value=None)
    channel_id = "managed-call"
    phone_id = "12345678-abcd-abcd-abcd-123456789abc"
    e._managed_call_channels = {channel_id: {"direction": "outbound", "business_id": 7,
        "phone_id": phone_id, "call_id": channel_id, "context_name": "business-7"}} if outbound else {}
    e._hotel_profile_cache[7] = (10**12, profile(7, voice="stale-cache"))
    e.bridges = {}
    e.vad_manager = None
    e.ari_client.answer_channel = AsyncMock()
    e.ari_client.create_bridge = AsyncMock(return_value="bridge")
    e.ari_client.add_channel_to_bridge = AsyncMock(return_value=True)

    async def command(method, path, **kwargs):
        if method == "GET":
            return {"value": {"AAVA_OUTBOUND": "1" if outbound else "", "AAVA_MANAGED_INGRESS": "1",
                "AAVA_RECORDING_STARTED": "1", "DIALED_NUMBER": "79991234567"}.get(kwargs.get("params", {}).get("variable"), "")}
        return {"status": 204}

    e.ari_client.send_command = AsyncMock(side_effect=command)
    monkeypatch.setattr(ManagedTelephony, "resolve", AsyncMock(return_value={"businessId": 7, "phoneId": phone_id, "contextName": "business-7"}))

    async def overwrite_cache(*args, **kwargs):
        e._hotel_profile_cache[7] = (10**12, profile(7, voice="concurrent-save"))

    monkeypatch.setattr(ManagedTelephony, "reserve", AsyncMock(side_effect=overwrite_cache))
    captured = []

    class SnapshotCaptured(BaseException):
        pass

    async def capture(session, **kwargs):
        captured.append(session)
        raise SnapshotCaptured()

    e._save_session = capture
    with pytest.raises(SnapshotCaptured):
        await e._handle_caller_stasis_start_hybrid(channel_id, {"caller": {}})
    assert captured[0].hotel_profile["voiceName"] == "edsel"
    assert captured[0].telephony_business_id == 7
    saved[7]["voiceSettings"]["neuro_gemini"]["voiceName"] = "later-save"
    assert captured[0].hotel_profile["voiceSettings"]["neuro_gemini"]["voiceName"] == "edsel"
    e._fetch_hotel_profile.assert_awaited_once_with(7)


@pytest.mark.asyncio
async def test_partial_asr_hypotheses_do_not_duplicate_durable_transcripts():
    from src.core.session_store import SessionStore
    e = object.__new__(Engine)
    e.session_store = SessionStore()
    call = CallSession("partial-asr", "partial-asr", provider_name="neuro_gemini")
    await e.session_store.upsert_call(call)
    for text in ("I need", "I need a room"):
        await e.on_provider_event({"type": "transcript", "call_id": call.call_id, "text": text, "is_final": False})
    assert call.conversation_history == []
    assert call.last_transcript is None
    assert call.last_transcription_ts == 0.0
    await e.on_provider_event({"type": "transcript", "call_id": call.call_id, "text": "I need a room today", "is_final": True})
    assert len(call.conversation_history) == 1
    assert call.conversation_history[0]["content"] == "I need a room today"
    assert call.last_transcript == "I need a room today"
    assert call.last_transcription_ts > 0.0
