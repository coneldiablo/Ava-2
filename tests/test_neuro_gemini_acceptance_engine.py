"""Independent settings-to-call acceptance; no audio, cloud, SIP, or CRM writes.

The default profiles are deliberately synthetic wire fixtures, not a provider
catalog. Set AVA_NEURO_PROFILE_FIXTURE to a JSON file (or inline JSON) containing
{initial: [A, B], updated: A_after_save, restored: A_after_switch_back} to run the
same assertions against canonical responses exported by the full backend app.
Only transport, persistence I/O, and provider network I/O are replaced here.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.core.models import CallSession
from src.core.transport_orchestrator import ContextConfig
from src.engine import Engine


def _wire(value):
    return json.loads(json.dumps(value))


def _synthetic_profile(business_id, model, voice):
    return {
        "id": business_id,
        "businessId": business_id,
        "instanceId": business_id,
        "name": f"Acceptance business {business_id}",
        "voiceContextName": "acceptance-context",
        "voiceAiProvider": "neuro_gemini",
        "voiceModel": model,
        "voiceName": voice,
        "voiceSettings": {"neuro_gemini": {"model": model, "voiceName": voice}},
        "systemPrompt": f"Scoped instruction {business_id}",
        "voiceGreetingTemplate": "Hello from {hotel_name}",
        "outboundOpenerTemplate": "Outbound from {hotel_name}",
    }


@pytest.fixture
def canonical_profiles():
    configured = os.environ.get("AVA_NEURO_PROFILE_FIXTURE", "").strip()
    if configured:
        raw = configured if configured.startswith("{") else Path(configured).read_text(encoding="utf-8")
        payload = json.loads(raw)
    else:
        first = _synthetic_profile(900001, "gemini-3.8-flash", "synthetic-neuro-A")
        second = _synthetic_profile(900002, "gemini-3.7-flash", "synthetic-neuro-B")
        updated = _wire(first)
        updated["voiceModel"] = "gemini-3.7-flash"
        updated["voiceName"] = "synthetic-neuro-C"
        updated["voiceSettings"]["neuro_gemini"] = {
            "model": updated["voiceModel"], "voiceName": updated["voiceName"]
        }
        payload = {"initial": [first, second], "updated": updated, "restored": _wire(updated)}

    assert len(payload["initial"]) == 2
    first, second = payload["initial"]
    assert int(first["id"]) != int(second["id"])
    for profile in [first, second, payload["updated"], payload["restored"]]:
        assert profile["voiceAiProvider"] == "neuro_gemini"
        assert profile["voiceModel"] and profile["voiceName"]
        assert profile["voiceSettings"]["neuro_gemini"] == {
            "model": profile["voiceModel"], "voiceName": profile["voiceName"]
        }
    assert (first["voiceModel"], first["voiceName"]) != (second["voiceModel"], second["voiceName"])
    assert (first["voiceModel"], first["voiceName"]) != (
        payload["updated"]["voiceModel"], payload["updated"]["voiceName"]
    )
    return _wire(payload)


class _CallHarness:
    """Exercise the real engine setup, with two concurrent tenant wire sources."""

    def __init__(self, profiles):
        self.wire_profiles = {int(profile["id"]): _wire(profile) for profile in profiles}
        self.calls = {}
        self.created = []
        self.fetches = []
        self.engine = engine = object.__new__(Engine)
        engine._hotel_profile_cache = {}
        engine._hotel_profiles_list_cache = (0.0, [])
        engine._hotel_profile_cache_ttl_seconds = 30
        engine._call_providers = {}
        engine._provider_start_tasks = {}
        engine.config = SimpleNamespace(
            default_provider="google_live", audio_transport="audiosocket", contexts={}, tools={},
            dict=lambda: {"tools": {}},
        )
        engine.pipeline_orchestrator = SimpleNamespace(enabled=False)
        engine.conversation_coordinator = None
        engine.streaming_playback_manager = SimpleNamespace()
        engine._execute_pre_call_tools = AsyncMock(return_value={})
        engine._cleanup_call = AsyncMock()
        engine.ari_client = SimpleNamespace(send_command=self._channel_variable, hangup_channel=AsyncMock())
        engine._fetch_hotel_profile = self._fetch
        engine._hotel_profile_base_url = lambda: "https://crm.synthetic.invalid"
        engine._save_session = self._save
        engine.session_store = SimpleNamespace(get_by_call_id=self._read, upsert_call=self._save)
        self.context = ContextConfig(
            prompt="Trusted acceptance policy for {hotel_name}.",
            greeting="Fallback greeting", outbound_greeting="Fallback outbound", tools=[],
        )
        engine.transport_orchestrator = SimpleNamespace(
            get_context_config=lambda _name: self.context,
            resolve_transport=lambda **_kwargs: SimpleNamespace(
                profile_name="acceptance-pcm", wire_encoding="pcm16", wire_sample_rate=8000,
                chunk_ms=20, idle_cutoff_ms=1500, context="acceptance-context",
            ),
        )
        self.template = SimpleNamespace(
            model="template-model", voice_name="template-voice",
            instructions="Trusted acceptance policy", greeting="template greeting",
            target_encoding="pcm16", target_sample_rate_hz=8000,
            nested={"sentinel": "untouched"},
        )
        engine.providers = {
            name: SimpleNamespace(config=engine._clone_config(self.template))
            for name in ("neuro_gemini", "google_live")
        }
        engine.provider_factories = {
            name: lambda name=name: self._provider(name) for name in engine.providers
        }

    async def _save(self, call, **_kwargs):
        self.calls[call.call_id] = call

    async def _read(self, call_id):
        return self.calls.get(call_id)

    async def _fetch(self, business_id):
        self.fetches.append(business_id)
        await asyncio.sleep(0)
        return _wire(self.wire_profiles[business_id])

    async def _channel_variable(self, _method, endpoint, *, params, **_kwargs):
        channel = endpoint.split("/")[1]
        call = self.calls[channel]
        values = {"AAVA_BUSINESS_ID": str(call.business_id), "AI_CONTEXT": "acceptance-context"}
        return {"value": values.get(params["variable"], "")}

    def _provider(self, selected):
        provider = SimpleNamespace(config=self.engine._clone_config(self.template),
                                   selected=selected, stop_session=AsyncMock())

        async def start_session(call_id, context=None):
            await asyncio.sleep(0)
            provider.started_call_id = call_id
            provider.started_context = copy.deepcopy(context)

        provider.start_session = AsyncMock(side_effect=start_session)
        self.created.append(provider)
        return provider

    async def call(self, business_id, suffix, *, outbound=False):
        call_id = f"acceptance-{business_id}-{suffix}"
        call = CallSession(call_id=call_id, caller_channel_id=call_id, business_id=business_id,
                           context_name="acceptance-context")
        call.is_outbound = outbound
        self.calls[call_id] = call
        await self.engine._resolve_audio_profile(call, call.caller_channel_id)
        await self.engine._start_provider_session(call.call_id)
        assert call.provider_session_active, f"Call setup failed: {call.error_message}"
        return call, self.engine._call_providers[call_id]


def _assert_selection(call, provider, expected):
    assert call.business_id == int(expected["id"])
    assert call.provider_name == expected["voiceAiProvider"]
    assert provider.selected == expected["voiceAiProvider"]
    assert call.hotel_profile["voiceModel"] == expected["voiceModel"]
    assert call.hotel_profile["voiceName"] == expected["voiceName"]
    assert provider.config.model == expected["voiceModel"], (
        "Saved voiceModel was not applied to the per-call provider config"
    )
    assert provider.config.voice_name == expected["voiceName"]
    assert provider.started_context["business_id"] == int(expected["id"])
    provider.start_session.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("outbound", [False, True], ids=["inbound", "outbound"])
async def test_canonical_serialized_two_businesses_reach_distinct_concurrent_calls(canonical_profiles, outbound):
    first, second = canonical_profiles["initial"]
    harness = _CallHarness([first, second])
    pairs = await asyncio.gather(
        harness.call(int(first["id"]), "parallel", outbound=outbound),
        harness.call(int(second["id"]), "parallel", outbound=outbound),
    )
    for (call, provider), expected, foreign in zip(pairs, [first, second], [second, first]):
        _assert_selection(call, provider, expected)
        instructions = provider.started_context["instructions"]
        assert expected["name"] in instructions
        assert foreign["name"] not in instructions
        if expected.get("systemPrompt"):
            assert expected["systemPrompt"] in instructions
        if foreign.get("systemPrompt") and foreign["systemPrompt"] != expected.get("systemPrompt"):
            assert foreign["systemPrompt"] not in instructions
        template = expected.get("outboundOpenerTemplate") if outbound else expected.get("voiceGreetingTemplate")
        if template:
            assert provider.started_context["greeting"] == harness.engine._apply_prompt_template_substitution(template, call)
    assert pairs[0][1] is not pairs[1][1]
    assert pairs[0][1].config is not pairs[1][1].config
    assert harness.template.voice_name == "template-voice"
    assert harness.template.model == "template-model"


@pytest.mark.asyncio
async def test_next_call_reads_saved_change_immediately_and_keeps_active_snapshot(canonical_profiles):
    first, second = canonical_profiles["initial"]
    updated = canonical_profiles["updated"]
    business_id = int(first["id"])
    harness = _CallHarness([first, second])
    # Prewarm the normal 30-second cache as an earlier request/call would.
    await harness.engine._resolve_hotel_profile(business_id, "acceptance-context")
    active_call, active_provider = await harness.call(business_id, "active")
    _assert_selection(active_call, active_provider, first)
    active_profile = copy.deepcopy(active_call.hotel_profile)
    active_config = copy.deepcopy(vars(active_provider.config))

    harness.wire_profiles[business_id] = _wire(updated)
    next_call, next_provider = await harness.call(business_id, "after-save")
    _assert_selection(next_call, next_provider, updated)
    assert active_call.hotel_profile == active_profile
    assert vars(active_provider.config) == active_config

    # Cached nested state must not be the active call's mutable profile.
    cached_profile = harness.engine._hotel_profile_cache[business_id][1]
    cached_profile["voiceSettings"]["neuro_gemini"]["voiceName"] = "cache-poison"
    assert active_call.hotel_profile == active_profile
    assert next_call.hotel_profile["voiceSettings"]["neuro_gemini"]["voiceName"] == updated["voiceName"]
    assert active_provider.config.nested is not next_provider.config.nested
    active_provider.config.nested["sentinel"] = "call-local"
    assert next_provider.config.nested == harness.template.nested == {"sentinel": "untouched"}


@pytest.mark.asyncio
async def test_switch_back_canonical_readback_starts_exact_saved_provider_selection(canonical_profiles):
    first, second = canonical_profiles["initial"]
    updated, restored = canonical_profiles["updated"], canonical_profiles["restored"]
    assert int(first["id"]) == int(updated["id"]) == int(restored["id"])
    assert restored["voiceSettings"]["neuro_gemini"] == updated["voiceSettings"]["neuro_gemini"]
    assert (restored["voiceModel"], restored["voiceName"]) == (updated["voiceModel"], updated["voiceName"])
    harness = _CallHarness([restored, second])
    call, provider = await harness.call(int(restored["id"]), "restored", outbound=True)
    _assert_selection(call, provider, updated)
    assert provider.config.voice_name != "template-voice"


@pytest.mark.asyncio
async def test_registered_real_provider_factory_applies_canonical_settings_without_template_mutation(canonical_profiles, monkeypatch):
    first, second = canonical_profiles["initial"]
    harness = _CallHarness([first, second])
    engine = harness.engine
    monkeypatch.setenv("NEURO_API_KEY", "synthetic-acceptance-only")
    monkeypatch.delenv("NEURO_GEMINI_MODELS", raising=False)
    engine.config.providers = {"neuro_gemini": {"voice_name": "template-voice"}}
    engine.config.pipelines = {}
    engine.config.default_provider = "neuro_gemini"
    engine.provider_alignment_issues = {}
    engine.audio_gating_manager = None
    engine._audit_provider_config = lambda *_args: []
    engine._describe_provider_alignment = lambda *_args: []
    await engine._load_providers()
    assert "neuro_gemini" in engine.provider_factories
    factory = engine.provider_factories["neuro_gemini"]
    template = engine.providers["neuro_gemini"]
    before = template.config.model_dump(exclude={"api_key"})

    def isolated_provider():
        provider = factory()
        provider.selected = "neuro_gemini"

        async def capture_start(call_id, context=None):
            provider.started_call_id = call_id
            provider.started_context = copy.deepcopy(context)

        # Keep the real constructor/config/factory; replace only network startup.
        provider.start_session = AsyncMock(side_effect=capture_start)
        harness.created.append(provider)
        return provider

    engine.provider_factories["neuro_gemini"] = isolated_provider
    pairs = await asyncio.gather(
        harness.call(int(first["id"]), "real-factory"),
        harness.call(int(second["id"]), "real-factory"),
    )
    for (call, provider), expected in zip(pairs, [first, second]):
        _assert_selection(call, provider, expected)
        assert provider.is_ready()
        assert provider.config is not template.config
    assert pairs[0][1].config is not pairs[1][1].config
    assert template.config.model_dump(exclude={"api_key"}) == before


@pytest.mark.asyncio
async def test_managed_outbound_admission_reads_fresh_profile_then_keeps_admitted_scope(canonical_profiles, monkeypatch):
    from src import engine as engine_module

    first, second = canonical_profiles["initial"]
    updated = canonical_profiles["updated"]
    business_id = int(first["id"])
    harness = _CallHarness([first, second])
    await harness.engine._resolve_hotel_profile(business_id, "acceptance-context")
    harness.wire_profiles[business_id] = _wire(updated)
    source = AsyncMock(return_value={"managed": True, "phone_id": "synthetic-source"})
    monkeypatch.setattr(engine_module, "ManagedTelephony", lambda: SimpleNamespace(source=source))
    monkeypatch.setenv("AVA_MANAGED_TELEPHONY_ENABLED", "true")
    context_name, admitted_profile, route = await harness.engine._outbound_telephony_route(
        {"source_number_id": "synthetic-source"}, business_id, "acceptance-context"
    )
    source.assert_awaited_once_with(business_id, "synthetic-source")
    assert route["managed"] is True
    assert admitted_profile["voiceName"] == updated["voiceName"]
    assert admitted_profile["voiceModel"] == updated["voiceModel"]
    call_id = f"acceptance-{business_id}-managed"
    call = CallSession(
        call_id=call_id, caller_channel_id=call_id, business_id=int(second["id"]),
        context_name="foreign-channel-context", hotel_profile=copy.deepcopy(admitted_profile),
        telephony_business_id=business_id, telephony_context_name=context_name,
    )
    call.is_outbound = True
    harness.calls[call_id] = call
    # The durable admission owns the scope even when channel variables disagree;
    # subsequent settings edits cannot replace the admitted call snapshot.
    harness.wire_profiles[business_id] = _wire(first)
    harness.engine._fetch_hotel_profile = AsyncMock(side_effect=AssertionError("Admitted call must retain its snapshot"))
    await harness.engine._resolve_audio_profile(call, call_id)
    await harness.engine._start_provider_session(call_id)
    assert call.provider_session_active
    _assert_selection(call, harness.engine._call_providers[call_id], updated)
    assert call.context_name == context_name
    harness.engine._fetch_hotel_profile.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("remote_kind,configured", [
    ("missing", True), ("missing", False), ("unidentified", True), ("foreign", True),
], ids=["missing-configured-crm", "missing-unconfigured-crm", "unidentified", "foreign"])
async def test_fresh_profile_failure_cannot_silently_switch_known_saved_provider(canonical_profiles, remote_kind, configured):
    first, second = canonical_profiles["initial"]
    business_id = int(first["id"])
    harness = _CallHarness([first, second])
    await harness.engine._resolve_hotel_profile(business_id, "acceptance-context")
    if not configured:
        harness.engine._hotel_profile_base_url = lambda: ""
    if remote_kind == "missing":
        remote = None
    elif remote_kind == "foreign":
        remote = _wire(second)
    else:
        remote = _wire(first)
        for key in ("id", "business_id", "businessId", "instance_id", "instanceId"):
            remote.pop(key, None)
    harness.engine._fetch_hotel_profile = AsyncMock(return_value=remote)
    call_id = f"acceptance-{business_id}-profile-{remote_kind}"
    call = CallSession(call_id=call_id, caller_channel_id=call_id, business_id=business_id,
                       context_name="acceptance-context")
    harness.calls[call_id] = call
    await harness.engine._resolve_audio_profile(call, call.caller_channel_id)
    await harness.engine._start_provider_session(call.call_id)
    assert not call.provider_session_active, "A failed fresh canonical read must fail call setup closed"
    assert call.error_message, "The terminal settings lookup error must survive in call history"
    assert not harness.created, "No default or unverified provider may start after canonical settings lookup fails"
    harness.engine.ari_client.hangup_channel.assert_awaited_once_with(call_id)


@pytest.mark.parametrize("identity", [{}, {"id": 900002}, {"id": 900001, "instanceId": 900002}])
def test_unidentified_or_foreign_profile_cannot_supply_model_or_voice(identity):
    engine = object.__new__(Engine)
    foreign = {
        **identity, "voiceAiProvider": "neuro_gemini", "voiceModel": "foreign-model",
        "voiceName": "foreign-voice", "voiceSettings": {
            "neuro_gemini": {"model": "foreign-model", "voiceName": "foreign-voice"}
        },
    }
    normalized = engine._normalize_hotel_profile(foreign, 900001)
    assert not normalized.get("voiceAiProvider")
    assert not normalized.get("voiceModel")
    assert not normalized.get("voiceName")
    assert not normalized.get("voiceSettings")
