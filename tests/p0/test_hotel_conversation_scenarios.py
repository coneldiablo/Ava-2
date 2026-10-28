"""Contract tests for the hotel conversation scenario pack (P1 task #10).

These are deterministic composition tests: no live LLM/provider calls. They
assert how the vertical scenario pack is selected, rendered, scoped and how it
keeps the generic multi-business flow untouched.
"""

import re
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from src.core.models import CallSession
from src.core.scenario_packs import (
    ScenarioPack,
    clear_scenario_pack_cache,
    load_scenario_pack,
    scenario_packs_dir,
)
from src.engine import Engine


ROOT = Path(__file__).resolve().parents[2]
HOTEL_PACK_PATH = ROOT / "config" / "scenarios" / "hotel.yaml"

GENERIC_CONTEXT_PROMPT = (
    "Ты AVA, голосовой AI-ассистент объединенного отдела продаж.\n"
    "Контекст клиента: {sales_customer_context}\n"
    "Рекомендованный следующий шаг: {sales_next_action}\n"
    "Исходящий опенер: {sales_outbound_opening}"
)


@pytest.fixture(autouse=True)
def _reset_scenario_pack_cache():
    clear_scenario_pack_cache()
    yield
    clear_scenario_pack_cache()


def make_engine():
    engine = Engine.__new__(Engine)
    engine._hotel_profile_cache_ttl_seconds = 30
    engine._hotel_profile_cache = {}
    engine._hotel_profiles_list_cache = (0.0, [])
    return engine


def business_profile(
    business_id=2,
    name="Grand Pilot Hotel",
    business_type="hotel",
    tone="тёплый премиальный консьерж",
    timezone="Europe/Moscow",
):
    return {
        "id": business_id,
        "business_id": business_id,
        "businessId": business_id,
        "instance_id": business_id,
        "instanceId": business_id,
        "businessType": business_type,
        "name": name,
        "hotelTone": tone,
        "hotelTimezone": timezone,
        "hotelWorkingHours": {"mon": {"enabled": True, "start": "08:00", "end": "22:00"}},
        "knowledgeBaseInstanceId": business_id,
        "voiceContextName": "unified_sales_agent",
        "voiceGreetingTemplate": "",
        "outboundOpenerTemplate": "",
    }


def make_session(profile, *, outbound=False, call_id="call-scenarios", **extra):
    session = CallSession(
        call_id=call_id,
        caller_channel_id=f"caller-{call_id}",
        caller_number="79990000001",
        context_name="unified_sales_agent",
        business_id=int(profile.get("business_id") or 1),
        hotel_profile=dict(profile),
    )
    session.is_outbound = outbound
    for key, value in extra.items():
        setattr(session, key, value)
    return session


# ---------------------------------------------------------------------------
# 1. Hotel inbound prompt composition
# ---------------------------------------------------------------------------


def test_hotel_inbound_prompt_carries_profile_and_inbound_scenarios():
    engine = make_engine()
    session = make_session(business_profile())

    prompt = engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session)

    # Hotel identity comes from the profile, not from a hardcoded prompt.
    assert "Grand Pilot Hotel" in prompt
    assert "тёплый премиальный консьерж" in prompt
    assert "Europe/Moscow" in prompt
    assert "Business/instance scope: 2." in prompt

    # Direction-specific scenario block.
    assert "СЦЕНАРИИ РАЗГОВОРА (hotel/inbound, pack v1):" in prompt
    assert "ПРАВИЛА ИСХОДЯЩЕГО ЗВОНКА:" not in prompt
    for title in (
        "Бронирование",
        "Услуги отеля",
        "Трансфер",
        "Цены",
        "Свободные даты и наличие номеров",
        "Передача администратору",
    ):
        assert title in prompt, title

    # Vertical persona replaces the abstract "AI-ассистент отдела продаж" framing.
    assert "голосовой сотрудник службы приёма и размещения отеля Grand Pilot Hotel" in prompt
    assert "{hotel_name}" not in prompt


def test_scenario_pack_block_is_idempotent():
    """The engine composes the prompt twice per call (session override, then provider)."""
    engine = make_engine()
    session = make_session(business_profile())

    once = engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session)
    twice = engine._compose_context_prompt(once, session)

    assert once == twice
    assert once.count("СЦЕНАРИИ РАЗГОВОРА (hotel/inbound") == 1
    assert once.count("Текущий отель: Grand Pilot Hotel.") == 1


@pytest.mark.parametrize(
    "raw_business_type",
    ["../../etc/passwd", "hotel/../secret", "HOTEL", " hotel "],
)
def test_business_type_is_sanitized_before_pack_lookup(raw_business_type):
    engine = make_engine()
    profile = business_profile(business_type=raw_business_type)
    session = make_session(profile, call_id="call-business-type")

    normalized = engine._session_business_type(session)
    assert re.fullmatch(r"[a-z0-9_]*", normalized), normalized

    pack = engine._resolve_scenario_pack(session)
    if raw_business_type.strip().lower() == "hotel":
        assert pack is not None and pack.business_type == "hotel"
    else:
        assert pack is None


# ---------------------------------------------------------------------------
# 2. Tenant isolation between two hotels
# ---------------------------------------------------------------------------


def test_two_hotels_get_separate_prompts_without_cross_tenant_leakage():
    engine = make_engine()
    hotel_a = business_profile(2, "Grand Pilot Hotel", tone="тёплый премиальный консьерж", timezone="Europe/Moscow")
    hotel_b = business_profile(3, "Seaside Boutique", tone="короткий деловой", timezone="Asia/Yekaterinburg")

    prompt_a = engine._compose_context_prompt(
        GENERIC_CONTEXT_PROMPT, make_session(hotel_a, call_id="call-a")
    )
    prompt_b = engine._compose_context_prompt(
        GENERIC_CONTEXT_PROMPT, make_session(hotel_b, call_id="call-b")
    )

    assert prompt_a != prompt_b

    assert "Grand Pilot Hotel" not in prompt_b
    assert "тёплый премиальный консьерж" not in prompt_b
    assert "Europe/Moscow" not in prompt_b
    assert "Business/instance scope: 3." in prompt_b

    assert "Seaside Boutique" not in prompt_a
    assert "Asia/Yekaterinburg" not in prompt_a
    assert "Business/instance scope: 2." in prompt_a

    # Both hotels share the same vertical pack — only tenant data differs.
    assert "СЦЕНАРИИ РАЗГОВОРА (hotel/inbound, pack v1):" in prompt_a
    assert "СЦЕНАРИИ РАЗГОВОРА (hotel/inbound, pack v1):" in prompt_b


# ---------------------------------------------------------------------------
# 3. Generic (non-hotel) businesses stay generic
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("business_type", ["", "standard", "coffee_shop", "clinic"])
def test_non_hotel_business_does_not_get_hotel_scenarios(business_type):
    engine = make_engine()
    profile = business_profile(5, "Coffee Point", business_type=business_type, tone="", timezone="UTC")
    session = make_session(profile, call_id=f"call-generic-{business_type or 'empty'}")

    prompt = engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session)

    assert "СЦЕНАРИИ РАЗГОВОРА" not in prompt
    assert "Бронирование" not in prompt
    assert "Передача администратору" not in prompt
    # Generic sales flow is preserved untouched.
    assert prompt.startswith("Ты AVA, голосовой AI-ассистент объединенного отдела продаж.")
    assert "Coffee Point" in prompt


def test_session_without_business_profile_stays_generic():
    engine = make_engine()
    session = CallSession(
        call_id="call-no-profile",
        caller_channel_id="caller-no-profile",
        context_name="unified_sales_agent",
        business_id=1,
    )

    assert engine._session_business_type(session) == ""
    assert engine._resolve_scenario_pack(session) is None
    assert engine._append_scenario_pack_to_prompt(GENERIC_CONTEXT_PROMPT, session) == GENERIC_CONTEXT_PROMPT


def test_hotel_profile_normalization_defaults_to_generic_business_type(monkeypatch):
    engine = make_engine()
    monkeypatch.delenv("AAVA_BUSINESS_TYPE", raising=False)

    fallback = engine._fallback_hotel_profile(7)
    assert fallback["businessType"] == ""

    normalized = engine._normalize_hotel_profile({"id": 7, "name": "X", "businessType": "Hotel"}, 7)
    assert normalized["businessType"] == "hotel"


# ---------------------------------------------------------------------------
# 4. Outbound direction
# ---------------------------------------------------------------------------


def test_outbound_prompt_uses_outbound_scenarios_and_bans_inbound_opening():
    engine = make_engine()
    session = make_session(business_profile(), outbound=True, call_id="call-outbound")
    session.pre_call_results = {
        "sales_outbound_opening": (
            "Здравствуйте, это Grand Pilot Hotel. Вы уточняли номер на выходные, "
            "удобно коротко поговорить?"
        )
    }

    prompt = engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session)

    assert "СЦЕНАРИИ РАЗГОВОРА (hotel/outbound, pack v1):" in prompt
    assert "ПРАВИЛА ВХОДЯЩЕГО ЗВОНКА:" not in prompt
    for title in ("Возврат к заявке", "Уточнение дат", "Допродажа", "Напоминание"):
        assert title in prompt, title

    assert 'Запрещено начинать разговор с "чем могу помочь"' in prompt
    assert "не повторяй её и не здоровайся второй раз" in prompt
    # The pre-generated opener is injected into the prompt exactly once.
    assert prompt.count("Вы уточняли номер на выходные") == 1


def test_outbound_greeting_prefers_sales_brain_opening_and_is_not_duplicated():
    engine = make_engine()
    session = make_session(business_profile(), outbound=True, call_id="call-outbound-greeting")
    opening = "Здравствуйте, это Grand Pilot Hotel. Звоню по вашей заявке на 12 мая, удобно говорить?"
    session.pre_call_results = {"sales_outbound_opening": opening}
    context_config = SimpleNamespace(
        greeting="Здравствуйте! Чем могу помочь?",
        outbound_greeting="fallback opener",
    )

    greeting = engine._apply_prompt_template_substitution(
        engine._select_context_greeting(context_config, session), session
    )

    assert greeting == opening
    assert "Чем могу помочь" not in greeting


@pytest.mark.parametrize(
    "raw_opening",
    [
        "Здравствуйте, это Grand Pilot Hotel. Чем могу помочь?",
        "Добрый день, это Grand Pilot Hotel! Чем я могу помочь вам сегодня?",
    ],
)
def test_outbound_opening_strips_inbound_style_phrases(raw_opening):
    engine = make_engine()
    session = make_session(business_profile(), outbound=True, call_id="call-outbound-sanitize")
    session.pre_call_results = {"sales_outbound_opening": raw_opening}
    context_config = SimpleNamespace(greeting="inbound", outbound_greeting="fallback")

    greeting = engine._select_context_greeting(context_config, session)

    assert "могу помочь" not in greeting.lower()
    assert "Grand Pilot Hotel" in greeting


def test_outbound_opening_falls_back_to_neutral_wording_without_invented_details():
    engine = make_engine()
    session = make_session(business_profile(), outbound=True, call_id="call-outbound-fallback")
    session.pre_call_results = {"sales_outbound_opening": "Чем могу помочь?"}
    context_config = SimpleNamespace(greeting="inbound", outbound_greeting="Чем могу помочь?")

    greeting = engine._apply_prompt_template_substitution(
        engine._select_context_greeting(context_config, session), session
    )

    assert greeting == (
        "Здравствуйте, это Grand Pilot Hotel. Звоню по вашему недавнему обращению, "
        "удобно сейчас коротко поговорить?"
    )
    # Neutral fallback must not invent dates, prices or availability.
    assert not re.search(r"\d{1,2}\s*(мая|июня|июля)|руб|свободн", greeting.lower())


def test_generic_business_outbound_greeting_is_not_rewritten():
    engine = make_engine()
    profile = business_profile(5, "Coffee Point", business_type="coffee_shop", tone="", timezone="UTC")
    session = make_session(profile, outbound=True, call_id="call-generic-outbound")
    session.pre_call_results = {"sales_outbound_opening": "Здравствуйте! Чем могу помочь?"}
    context_config = SimpleNamespace(greeting="inbound", outbound_greeting="fallback")

    assert engine._select_context_greeting(context_config, session) == "Здравствуйте! Чем могу помочь?"


# ---------------------------------------------------------------------------
# 5. RAG / unknown facts
# ---------------------------------------------------------------------------


def test_pack_forces_no_answer_handoff_wording_for_unknown_facts():
    pack = load_scenario_pack("hotel")
    rules = " ".join(pack.safety_rules).lower()

    assert "уточнит администратор" in rules
    assert "не придумывай" in rules

    inbound = {entry.id: " ".join(entry.guidance).lower() for entry in pack.inbound.scenarios}
    assert "уточнит администратор" in inbound["pricing"]
    assert "не выдумывай наличие" in inbound["availability"]
    assert "передай администратору" in inbound["availability"]
    assert "базе знаний" in inbound["services"]
    assert "не считай, что она есть" in inbound["services"]


def test_knowledge_answers_stay_inside_current_instance(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server

    calls = []

    def fake_post(path, payload):
        calls.append((path, dict(payload)))
        return {"success": True, "spoken": "ok"}

    monkeypatch.setattr(server, "_post_json", fake_post)

    server.answer_from_knowledge("Во сколько завтрак?", instance_id=2)
    server.answer_from_knowledge("Во сколько завтрак?", instance_id=3)

    assert [payload["instanceId"] for _, payload in calls] == [2, 3]
    assert all(path == "/api/ml/rag/answer" for path, _ in calls)

    pack = load_scenario_pack("hotel")
    scoping = " ".join(pack.safety_rules).lower()
    assert "другого отеля или бизнеса использовать нельзя" in scoping


# ---------------------------------------------------------------------------
# 6. Manager handoff reuses existing tools
# ---------------------------------------------------------------------------


def test_manager_handoff_scenario_covers_required_triggers():
    pack = load_scenario_pack("hotel")
    handoff = next(entry for entry in pack.inbound.scenarios if entry.id == "manager_handoff")
    text = " ".join(handoff.guidance).lower()

    for trigger in ("просит человека", "жалобе", "сложном изменении брони", "оплате", "дважды"):
        assert trigger in text, trigger
    assert "уже существующие инструменты" in text


def test_scenario_pack_does_not_introduce_new_tool_names():
    """Task #11 owns the handoff system; the pack may only lean on existing tools."""
    pack = load_scenario_pack("hotel")
    rendered = "\n".join(pack.render_prompt_block(direction) for direction in ("inbound", "outbound"))

    invented = set(re.findall(r"\b(?:mcp_[a-z_]+|[a-z_]+_tool|create_[a-z_]+|transfer_call)\b", rendered))
    assert invented == set(), invented

    # The pack is pure behaviour data: no tool allowlist, endpoints or credentials
    # of its own, so it cannot become a second handoff/routing subsystem.
    raw_pack = yaml.safe_load(HOTEL_PACK_PATH.read_text(encoding="utf-8"))
    forbidden_keys = {"tools", "endpoints", "url", "base_url", "token", "api_key", "instance_id", "business_id"}
    assert forbidden_keys.isdisjoint(raw_pack.keys())

    agent_config = yaml.safe_load((ROOT / "config" / "ai-agent.yaml").read_text(encoding="utf-8"))
    tools = agent_config["contexts"]["unified_sales_agent"]["tools"]
    for tool in ("transfer", "mcp_sales_create_manager_task", "mcp_sales_answer_from_knowledge"):
        assert tool in tools, tool


# ---------------------------------------------------------------------------
# 7. Prompt safety
# ---------------------------------------------------------------------------


def test_composed_prompt_carries_no_secrets_or_raw_crm_payloads(monkeypatch):
    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "super-secret-crm-token")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-super-secret-openai")
    monkeypatch.setenv("SALES_BRAIN_API_TOKEN", "super-secret-brain-token")

    engine = make_engine()
    session = make_session(business_profile(), call_id="call-safety")
    session.pre_call_results = {
        "sales_customer_context": "Клиент: Ирина. Статус: qualified. Последнее сообщение: нужен номер на выходные.",
        "sales_next_action": "уточнить даты",
    }

    prompt = engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session)

    for secret in ("super-secret-crm-token", "sk-super-secret-openai", "super-secret-brain-token"):
        assert secret not in prompt
    for marker in ("Authorization", "Bearer ", "api_key", "apiKey", '"chatId"', "@c.us"):
        assert marker not in prompt

    # Internal identifiers must never be spoken out loud.
    rules = " ".join(load_scenario_pack("hotel").safety_rules).lower()
    assert "не произноси вслух внутренние идентификаторы" in rules
    assert "id звонка" in rules
    assert "названия инструментов" in rules

    voice_rules = " ".join(load_scenario_pack("hotel").voice_rules).lower()
    assert "не зачитывай json" in voice_rules


# ---------------------------------------------------------------------------
# 8. Configuration validity and graceful degradation
# ---------------------------------------------------------------------------


def test_shipped_hotel_pack_passes_schema_validation():
    raw = yaml.safe_load(HOTEL_PACK_PATH.read_text(encoding="utf-8"))
    pack = ScenarioPack(**raw)

    assert pack.version >= 1
    assert pack.business_type == "hotel"
    assert pack.inbound.scenario_ids() == [
        "booking",
        "services",
        "transfer",
        "pricing",
        "availability",
        "manager_handoff",
    ]
    assert pack.outbound.scenario_ids() == [
        "request_followup",
        "date_clarification",
        "upsell",
        "reminder",
    ]
    assert pack.outbound.fallback_opening
    assert "чем могу помочь" in [item.lower() for item in pack.outbound.forbidden_openings]
    assert scenario_packs_dir().is_dir()


def test_invalid_pack_is_ignored_and_generic_flow_survives(tmp_path, monkeypatch):
    monkeypatch.setenv("AAVA_SCENARIO_PACKS_DIR", str(tmp_path))
    clear_scenario_pack_cache()
    (tmp_path / "hotel.yaml").write_text("business_type: hotel\ninbound: [not, a, mapping]\n", encoding="utf-8")

    assert load_scenario_pack("hotel") is None

    engine = make_engine()
    session = make_session(business_profile(), call_id="call-invalid-pack")
    prompt = engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session)

    assert "СЦЕНАРИИ РАЗГОВОРА" not in prompt
    assert "Grand Pilot Hotel" in prompt


def test_missing_pack_directory_keeps_existing_context_working(tmp_path, monkeypatch):
    monkeypatch.setenv("AAVA_SCENARIO_PACKS_DIR", str(tmp_path / "does-not-exist"))
    clear_scenario_pack_cache()

    engine = make_engine()
    session = make_session(business_profile(), outbound=True, call_id="call-missing-pack")
    session.pre_call_results = {"sales_outbound_opening": "Здравствуйте, это отель. Чем могу помочь?"}
    context_config = SimpleNamespace(greeting="inbound", outbound_greeting="fallback")

    assert load_scenario_pack("hotel") is None
    assert engine._compose_context_prompt(GENERIC_CONTEXT_PROMPT, session).startswith(
        "Ты AVA, голосовой AI-ассистент объединенного отдела продаж."
    )
    # Without a pack the runtime does not rewrite openers either.
    assert engine._select_context_greeting(context_config, session) == (
        "Здравствуйте, это отель. Чем могу помочь?"
    )


def test_ai_agent_yaml_still_loads_with_scenario_packs_present(monkeypatch):
    monkeypatch.setenv("ASTERISK_ARI_USERNAME", "test_user")
    monkeypatch.setenv("ASTERISK_ARI_PASSWORD", "test_pass")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-key")

    from src.config import AppConfig, load_config

    config = load_config("config/ai-agent.yaml")

    assert isinstance(config, AppConfig)
    assert "unified_sales_agent" in config.contexts
