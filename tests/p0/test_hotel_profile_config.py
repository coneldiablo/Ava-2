import time
from types import SimpleNamespace

import pytest

from src.core.models import CallSession
from src.engine import Engine


def make_engine():
    engine = Engine.__new__(Engine)
    engine._hotel_profile_cache_ttl_seconds = 30
    engine._hotel_profile_cache = {}
    engine._hotel_profiles_list_cache = (0.0, [])
    return engine


def hotel_profile(business_id=2, name="Grand Pilot Hotel"):
    return {
        "id": business_id,
        "business_id": business_id,
        "instance_id": business_id,
        "instanceId": business_id,
        "name": name,
        "hotelTone": "friendly premium concierge",
        "hotelTimezone": "Europe/Moscow",
        "hotelWorkingHours": {
            "mon": {"enabled": True, "start": "08:00", "end": "22:00"},
            "tue": {"enabled": False, "start": "08:00", "end": "22:00"},
        },
        "sipAliases": ["74951234567", "1001"],
        "sipTrunkNumber": "mts-grand-pilot",
        "sipCallerId": "+74951234567",
        "knowledgeBaseInstanceId": business_id,
        "voiceContextName": "unified_sales_agent",
        "aiProvider": "google_live",
        "voiceName": "Aoede",
        "voiceGreetingTemplate": "Здравствуйте, это {hotel_name}. Чем могу помочь?",
        "outboundOpenerTemplate": "Здравствуйте, это Анастасия из {hotel_name}.",
    }


def test_business_voice_instructions_are_tenant_scoped_and_idempotent():
    engine = make_engine()
    base_prompt = "Trusted voice policy: use only the current business knowledge base."
    first = engine._normalize_hotel_profile({
        "id": 2, "name": "First Hotel", "systemPrompt": "Уточняй время заезда."
    }, 2)
    second = engine._normalize_hotel_profile({
        "id": 3, "name": "Second Hotel", "systemPrompt": "Уточняй время выезда."
    }, 3)
    first_session = CallSession(call_id="first-voice", caller_channel_id="first-channel", business_id=2,
                                hotel_profile=first)
    second_session = CallSession(call_id="second-voice", caller_channel_id="second-channel", business_id=3,
                                 hotel_profile=second)

    first_prompt = engine._compose_context_prompt(base_prompt, first_session)
    second_prompt = engine._compose_context_prompt(base_prompt, second_session)

    assert first_prompt.startswith(base_prompt)
    assert "Уточняй время заезда." in first_prompt
    assert "Уточняй время выезда." not in first_prompt
    assert "Уточняй время выезда." in second_prompt
    assert "Уточняй время заезда." not in second_prompt
    assert engine._compose_context_prompt(first_prompt, first_session) == first_prompt


def test_business_voice_instructions_fail_closed_for_foreign_or_missing_identity():
    engine = make_engine()
    base_prompt = "Trusted voice policy."
    foreign = engine._normalize_hotel_profile({"id": 3, "systemPrompt": "FOREIGN"}, 2)
    missing = engine._normalize_hotel_profile({"systemPrompt": "UNSCOPED"}, 2)
    session = CallSession(call_id="fallback-voice", caller_channel_id="fallback-channel", business_id=2)

    for profile in (foreign, missing, engine._normalize_hotel_profile(None, 2)):
        session.hotel_profile = profile
        prompt = engine._compose_context_prompt(base_prompt, session)
        assert "FOREIGN" not in prompt
        assert "UNSCOPED" not in prompt
        assert "BUSINESS_VOICE_INSTRUCTIONS" not in prompt

    # A raw provider override must not bypass the normalizer's tenant check.
    session.hotel_profile = {"id": 3, "systemPrompt": "FOREIGN"}
    assert engine._append_business_voice_instructions(base_prompt, session) == base_prompt


def test_raw_foreign_profile_cannot_leak_through_prompt_or_placeholders():
    engine = make_engine()
    session = CallSession(call_id="foreign-profile", caller_channel_id="foreign-channel", business_id=2,
                          hotel_profile={"id": 3, "instance_id": 3, "name": "Foreign Hotel",
                                         "hotelTone": "Foreign tone", "businessType": "hotel",
                                         "systemPrompt": "Foreign instructions"})
    prompt = engine._compose_context_prompt("Trusted {hotel_name} policy.", session)
    for foreign_value in ("Foreign Hotel", "Foreign tone", "Foreign instructions", "scope: 3"):
        assert foreign_value not in prompt
    assert "СЦЕНАРИИ РАЗГОВОРА (hotel/" not in prompt
    assert engine._session_business_profile(session) == {}


def test_business_voice_instructions_are_bounded_and_strip_controls():
    engine = make_engine()
    profile = engine._normalize_hotel_profile({"id": 2, "systemPrompt": "A\x00B" + "x" * 9000}, 2)
    assert profile["systemPrompt"].startswith("AB")
    assert "\x00" not in profile["systemPrompt"]
    assert len(profile["systemPrompt"]) <= 8000


@pytest.mark.asyncio
async def test_hotel_profile_resolver_uses_business_cache():
    engine = make_engine()
    profile = hotel_profile()
    engine._hotel_profile_cache = {2: (time.time(), profile)}

    resolved = await engine._resolve_hotel_profile(2, "unified_sales_agent")

    assert resolved["business_id"] == 2
    assert resolved["instance_id"] == 2
    assert resolved["name"] == "Grand Pilot Hotel"
    assert resolved["aiProvider"] == "google_live"
    assert resolved["voiceName"] == "Aoede"


def test_hotel_voice_is_applied_as_provider_override():
    engine = make_engine()
    provider = SimpleNamespace(
        config=SimpleNamespace(tts_voice_name="DefaultVoice"),
    )
    session = CallSession(
        call_id="call-hotel-voice",
        caller_channel_id="caller-hotel-voice",
        context_name="unified_sales_agent",
        business_id=2,
        provider_overrides={"voice_name": "Aoede"},
    )

    engine._apply_provider_overrides(provider, session)

    assert provider.config.tts_voice_name == "Aoede"


@pytest.mark.asyncio
async def test_hotel_profile_sip_alias_can_resolve_business_scope():
    engine = make_engine()
    engine._hotel_profiles_list_cache = (time.time(), [hotel_profile(2), hotel_profile(3, "Hotel B")])

    assert await engine._business_id_from_hotel_sip_alias("+7 (495) 123-45-67") == 2
    assert await engine._business_id_from_hotel_sip_alias("unknown") is None


def test_hotel_greeting_template_uses_concrete_hotel_name():
    engine = make_engine()
    session = CallSession(
        call_id="call-hotel-greeting",
        caller_channel_id="caller-hotel-greeting",
        context_name="unified_sales_agent",
        business_id=2,
        hotel_profile=hotel_profile(),
    )
    context_config = SimpleNamespace(
        greeting="fallback",
        outbound_greeting="outbound fallback",
    )

    template = engine._select_context_greeting(context_config, session)
    rendered = engine._apply_prompt_template_substitution(template, session)

    assert rendered == "Здравствуйте, это Grand Pilot Hotel. Чем могу помочь?"


def test_outbound_opening_payload_uses_hotel_profile_name_and_scope():
    engine = make_engine()
    profile = hotel_profile()
    engine._hotel_profile_cache = {2: (time.time(), profile)}

    payload = engine._outbound_build_opening_payload(
        campaign={"id": "camp-1", "business_id": 2},
        lead={"id": "lead-1", "phone_number": "79990000001", "name": "Ирина"},
        context_name="unified_sales_agent",
        custom_vars={},
    )

    assert payload["instanceId"] == "2"
    assert payload["businessName"] == "Grand Pilot Hotel"
    assert payload["hotelTone"] == "friendly premium concierge"
    assert payload["timezone"] == "Europe/Moscow"
    assert payload["knowledgeBaseInstanceId"] == "2"


def test_hotel_profile_fallback_keeps_legacy_default(monkeypatch):
    engine = make_engine()
    monkeypatch.setenv("AAVA_OUTBOUND_BUSINESS_NAME", "отеля Ava")

    payload = engine._outbound_build_opening_payload(
        campaign={"id": "camp-1"},
        lead={"id": "lead-1", "phone_number": "79990000001"},
        context_name="unified_sales_agent",
        custom_vars={},
    )

    assert payload["instanceId"] == "1"
    assert payload["businessName"] == "отеля Ava"


def test_hotel_profile_supplies_outbound_trunk_and_caller_id(monkeypatch):
    engine = make_engine()
    engine._outbound_callerid_num = "+70000000000"
    engine._outbound_trunk_endpoint = "global-trunk"
    monkeypatch.setenv("AAVA_OUTBOUND_CALLERID_NAME", "Global caller")

    routing = engine._outbound_resolve_routing(
        {},
        SimpleNamespace(callerid="+71111111111", callerid_name="Context caller"),
        hotel_profile(),
    )

    assert routing == {
        "caller_id": "+74951234567",
        "caller_id_name": "Context caller",
        "trunk": "mts-grand-pilot",
    }

    campaign_override = engine._outbound_resolve_routing(
        {"callerid": "+72222222222", "callerid_name": "Campaign caller"},
        None,
        hotel_profile(),
    )
    assert campaign_override["caller_id"] == "+72222222222"
    assert campaign_override["caller_id_name"] == "Campaign caller"


@pytest.mark.asyncio
async def test_hotel_trunk_is_used_for_external_endpoint():
    class MissingEndpointAri:
        async def send_command(self, *_args, **_kwargs):
            return {"status": 404}

    engine = make_engine()
    engine.ari_client = MissingEndpointAri()
    engine._outbound_dial_context = "from-internal"
    engine._outbound_dial_prefix = ""
    engine._outbound_channel_tech = "auto"
    engine._outbound_pjsip_endpoint_cache_ttl_seconds = 30
    engine._outbound_pjsip_endpoint_cache = {}
    engine._outbound_internal_extension_pattern = r"^[1-9][0-9]{2,5}$"
    engine._outbound_trunk_endpoint = "global-trunk"
    engine._outbound_trunk_tech = "PJSIP"

    endpoint = await engine._outbound_choose_endpoint(
        "79991234567",
        trunk_endpoint="mts-grand-pilot",
    )

    assert endpoint == "PJSIP/79991234567@mts-grand-pilot"
