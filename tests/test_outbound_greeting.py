from types import SimpleNamespace

from src.core.models import CallSession
from src.core.transport_orchestrator import TransportOrchestrator
from src.engine import Engine
from src.tools.context import PreCallContext
from src.tools.http.generic_lookup import HTTPLookupConfig, GenericHTTPLookupTool


def test_outbound_context_prefers_sales_brain_generated_opening():
    engine = Engine.__new__(Engine)
    session = CallSession(
        call_id="call-outbound-greeting",
        caller_channel_id="caller-outbound-greeting",
        caller_name="Outbound 79964204292",
        caller_number="79964204292",
        context_name="unified_sales_agent",
    )
    session.is_outbound = True
    session.pre_call_results = {
        "sales_outbound_opening": (
            "Здравствуйте, это Анастасия из отеля Ava. Видела, что вы уточняли "
            "свободный номер на выходные, удобно коротко поговорить?"
        )
    }
    context_config = SimpleNamespace(
        greeting="Здравствуйте! Чем могу помочь?",
        outbound_greeting="Здравствуйте, это Анастасия из отеля Ava. Звоню по вашему обращению.",
    )

    template = engine._select_context_greeting(context_config, session)
    rendered = engine._apply_prompt_template_substitution(template, session)

    assert template == session.pre_call_results["sales_outbound_opening"]
    assert "Анастасия из отеля Ava" in rendered
    assert "свободный номер на выходные" in rendered
    assert "Чем могу помочь" not in rendered


def test_outbound_context_prefers_predial_opening_from_custom_vars():
    engine = Engine.__new__(Engine)
    session = CallSession(
        call_id="call-predial-greeting",
        caller_channel_id="caller-predial-greeting",
        caller_number="79964204292",
        context_name="unified_sales_agent",
    )
    session.is_outbound = True
    session.outbound_custom_vars = {
        "sales_outbound_opening": (
            "Добрый день, это Анастасия из отеля Ava. Видела ваш вопрос по "
            "бронированию, удобно коротко поговорить?"
        )
    }
    context_config = SimpleNamespace(
        greeting="Здравствуйте! Чем могу помочь?",
        outbound_greeting="fallback",
    )

    template = engine._select_context_greeting(context_config, session)

    assert template == session.outbound_custom_vars["sales_outbound_opening"]
    assert "Чем могу помочь" not in template


def test_outbound_context_falls_back_to_configured_outbound_greeting():
    engine = Engine.__new__(Engine)
    session = CallSession(
        call_id="call-outbound-fallback",
        caller_channel_id="caller-outbound-fallback",
        caller_number="79964204292",
        context_name="unified_sales_agent",
    )
    session.is_outbound = True
    session.pre_call_results = {
        "sales_customer_context": (
            "Клиент: Иван. Статус: new. Последнее сообщение: Здравствуйте, "
            "подскажите про свободный номер на выходные. Следующий шаг: уточнить даты."
        )
    }
    context_config = SimpleNamespace(
        greeting="Здравствуйте! Чем могу помочь?",
        outbound_greeting=(
            "Здравствуйте, это Анастасия из отеля Ava. Вы недавно писали нам: "
            "«{outbound_opening_reason}»."
        ),
    )

    rendered = engine._apply_prompt_template_substitution(
        engine._select_context_greeting(context_config, session),
        session,
    )

    assert "подскажите про свободный номер на выходные" in rendered
    assert "Статус" not in rendered
    assert "Следующий шаг" not in rendered
    assert "Чем могу помочь" not in rendered


def test_inbound_context_keeps_regular_greeting():
    engine = Engine.__new__(Engine)
    session = CallSession(
        call_id="call-inbound-greeting",
        caller_channel_id="caller-inbound-greeting",
        caller_name="Client",
        caller_number="79964204292",
        context_name="unified_sales_agent",
    )
    context_config = SimpleNamespace(
        greeting="Здравствуйте! Я AVA, AI-ассистент отдела продаж. Чем могу помочь?",
        outbound_greeting="Здравствуйте, это Анастасия из отеля Ava.",
    )

    template = engine._select_context_greeting(context_config, session)

    assert template == context_config.greeting


def test_transport_orchestrator_loads_outbound_greeting():
    orchestrator = TransportOrchestrator({
        "contexts": {
            "sales": {
                "greeting": "Inbound greeting",
                "outbound_greeting": "Outbound greeting",
            }
        }
    })

    context = orchestrator.get_context_config("sales")

    assert context.greeting == "Inbound greeting"
    assert context.outbound_greeting == "Outbound greeting"


def test_pre_call_http_template_can_pass_outbound_custom_vars_json():
    tool = GenericHTTPLookupTool(HTTPLookupConfig(name="sales_brain_outbound_opening"))
    context = PreCallContext(
        call_id="call-1",
        caller_number="79964204292",
        context_name="unified_sales_agent",
        call_direction="outbound",
        campaign_id="camp-1",
        lead_id="lead-1",
        outbound_custom_vars={
            "whatsapp_chat_id": "79964204292@c.us",
            "last_message": "Есть номер на выходные?",
        },
    )

    body = tool._substitute_variables(
        (
            '{"phone":"{caller_number}","direction":"{call_direction}",'
            '"campaignId":"{campaign_id}","leadId":"{lead_id}",'
            '"outboundCustomVars":{outbound_custom_vars_json}}'
        ),
        context,
    )

    assert '"direction":"outbound"' in body
    assert '"whatsapp_chat_id": "79964204292@c.us"' in body
    assert '"last_message": "Есть номер на выходные?"' in body


def test_outbound_opening_payload_is_built_before_dial(monkeypatch):
    engine = Engine.__new__(Engine)
    monkeypatch.setenv("SALES_BRAIN_DEFAULT_INSTANCE_ID", "2")
    monkeypatch.setenv("AAVA_OUTBOUND_PERSONA_NAME", "Анастасия")
    monkeypatch.setenv("AAVA_OUTBOUND_BUSINESS_NAME", "отеля Ava")

    payload = engine._outbound_build_opening_payload(
        campaign={"id": "camp-1"},
        lead={
            "id": "lead-1",
            "phone_number": "79964204292",
            "name": "Ирина",
        },
        context_name="unified_sales_agent",
        custom_vars={"whatsapp_chat_id": "79964204292@c.us"},
    )

    assert payload["direction"] == "outbound"
    assert payload["instanceId"] == "2"
    assert payload["campaignId"] == "camp-1"
    assert payload["leadId"] == "lead-1"
    assert payload["phone"] == "79964204292"
    assert payload["personaName"] == "Анастасия"
    assert payload["businessName"] == "отеля Ava"
    assert payload["outboundCustomVars"]["whatsapp_chat_id"] == "79964204292@c.us"


def test_outbound_opening_pregeneration_skips_when_ready():
    engine = Engine.__new__(Engine)

    assert engine._outbound_should_pregenerate_opening(
        "unified_sales_agent",
        {},
    )
    assert not engine._outbound_should_pregenerate_opening(
        "unified_sales_agent",
        {"sales_outbound_opening": "Готовая фраза"},
    )
