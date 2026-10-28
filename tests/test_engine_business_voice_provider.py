from types import SimpleNamespace

import pytest

from src.engine import Engine


def engine_with_providers(*names):
    engine = object.__new__(Engine)
    engine.providers = {name: object() for name in names}
    engine.provider_factories = {name: lambda: object() for name in names}
    return engine


def session(profile, business_id=7):
    return SimpleNamespace(business_id=business_id, hotel_profile=profile, provider_overrides={}, call_id='call')


@pytest.mark.parametrize('name', ['yandex_realtime', 'google_live', 'openai_realtime', 'deepgram', 'local', 'elevenlabs_agent'])
def test_saved_business_provider_resolves_loaded_provider(name):
    engine = engine_with_providers(name)
    assert engine._business_voice_provider(session({'businessId': 7, 'voiceAiProvider': name})) == name


@pytest.mark.parametrize('profile', [
    {'businessId': 8, 'voiceAiProvider': 'yandex_realtime'},
    {'voiceAiProvider': 'yandex_realtime'},
    {'businessId': 7, 'instanceId': 8, 'voiceAiProvider': 'yandex_realtime'},
])
def test_unidentified_or_mismatched_tenant_cannot_override_provider(profile):
    assert engine_with_providers('yandex_realtime')._business_voice_provider(session(profile)) is None


def test_business_provider_unavailable_does_not_fallback_to_google():
    engine = engine_with_providers('google_live')
    with pytest.raises(RuntimeError, match='not loaded'):
        engine._business_voice_provider(session({'businessId': 7, 'voiceAiProvider': 'yandex_realtime'}))


def test_provider_template_without_factory_is_unavailable():
    engine = engine_with_providers('yandex_realtime')
    engine.provider_factories.clear()
    with pytest.raises(RuntimeError):
        engine._business_voice_provider(session({'businessId': 7, 'voiceAiProvider': 'yandex_realtime'}))


def test_unknown_business_provider_rejected():
    with pytest.raises(ValueError):
        engine_with_providers('unknown')._business_voice_provider(session({'businessId': 7, 'voiceAiProvider': 'unknown'}))


def test_per_call_prompt_override_replaces_dict_template_without_leakage():
    engine = engine_with_providers()
    template = {'instructions': 'template', 'prompt': 'template'}
    first = SimpleNamespace(config=engine._clone_config(template))
    second = SimpleNamespace(config=engine._clone_config(template))
    first_session = session({'businessId': 7})
    first_session.provider_overrides = {'prompt': 'business seven'}
    engine._apply_provider_overrides(first, first_session)
    assert first.config['instructions'] == 'business seven'
    assert second.config['instructions'] == template['instructions'] == 'template'


def test_separate_tenant_prompts_keep_context_and_do_not_leak():
    engine = engine_with_providers('yandex_realtime', 'google_live')
    first = session({'businessId': 7, 'systemPrompt': 'Seven business instructions'})
    second = session({'businessId': 8, 'systemPrompt': 'Eight business instructions'}, business_id=8)
    first_prompt = engine._append_business_voice_instructions('Sales Brain context', first)
    second_prompt = engine._append_business_voice_instructions('Sales Brain context', second)
    assert 'Sales Brain context' in first_prompt and 'Sales Brain context' in second_prompt
    assert 'Seven business instructions' in first_prompt and 'Seven business instructions' not in second_prompt
    assert 'Eight business instructions' in second_prompt and 'Eight business instructions' not in first_prompt
    assert engine._append_business_voice_instructions(first_prompt, first) == first_prompt


@pytest.mark.asyncio
async def test_unavailable_business_provider_never_starts_google_session():
    from unittest.mock import AsyncMock
    engine = engine_with_providers('google_live')
    business_session = session({'businessId': 7, 'voiceAiProvider': 'yandex_realtime'})
    business_session.provider_session_active = False
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=business_session))
    engine._call_providers = {}
    engine._execute_pre_call_tools = AsyncMock()
    engine._save_session = AsyncMock()
    engine._cleanup_call = AsyncMock()
    engine.config = SimpleNamespace(tools={})
    business_session.caller_channel_id = 'caller'
    business_session.provider_name = 'yandex_realtime'
    engine.ari_client = SimpleNamespace(hangup_channel=AsyncMock())
    await engine._start_provider_session('call')
    engine._execute_pre_call_tools.assert_not_awaited()
    assert business_session.error_message == 'voice_provider_startup_failed'
    engine._save_session.assert_awaited()
    engine.ari_client.hangup_channel.assert_awaited_once_with('caller')
    engine._cleanup_call.assert_awaited_once_with('call')
    assert engine._call_providers == {}


@pytest.mark.asyncio
async def test_saved_selection_reaches_per_call_session_with_tenant_prompt_and_readback():
    from unittest.mock import AsyncMock
    from src.core.models import CallSession
    engine = engine_with_providers('yandex_realtime', 'google_live')
    stored = {}
    created = []

    def factory():
        provider = SimpleNamespace(config=SimpleNamespace(instructions='Sales Brain context'), start_session=AsyncMock())
        created.append(provider)
        return provider

    engine.provider_factories['yandex_realtime'] = factory
    engine.provider_factories['google_live'] = lambda: pytest.fail('Google fallback invoked')
    engine.config = SimpleNamespace(default_provider='google_live', audio_transport='audiosocket', dict=lambda: {})
    engine.pipeline_orchestrator = SimpleNamespace(enabled=False)
    engine._call_providers = {}
    engine._execute_pre_call_tools = AsyncMock(return_value={})
    engine.conversation_coordinator = None
    engine.ari_client = object()
    engine._apply_prompt_template_substitution = lambda prompt, call: prompt
    engine._append_hotel_profile_to_prompt = lambda prompt, call: prompt
    engine._append_scenario_pack_to_prompt = lambda prompt, call: prompt

    async def save(call):
        stored[call.call_id] = call

    async def read(call_id):
        return stored[call_id]

    engine._save_session = save
    engine.session_store = SimpleNamespace(get_by_call_id=read)
    for business_id in (7, 8):
        call = CallSession(call_id=f'call-{business_id}', caller_channel_id=f'channel-{business_id}')
        call.business_id = business_id
        call.hotel_profile = {'businessId': business_id, 'voiceAiProvider': 'yandex_realtime', 'systemPrompt': f'Instructions business {business_id}'}
        stored[call.call_id] = call
        await engine._start_provider_session(call.call_id)
        readback = await engine.session_store.get_by_call_id(call.call_id)
        assert readback.provider_name == 'yandex_realtime'
        assert readback.provider_session_active is True
        context = created[-1].start_session.call_args.kwargs['context']
        assert context['business_id'] == business_id
        assert 'Sales Brain context' in context['instructions']
        assert f'Instructions business {business_id}' in context['instructions']
        assert f'Instructions business {15-business_id}' not in context['instructions']
    assert created[0] is not created[1]


@pytest.mark.asyncio
@pytest.mark.parametrize('missing', ['YANDEX_CLOUD_API_KEY', 'YANDEX_CLOUD_FOLDER_ID'])
async def test_yandex_not_registered_with_missing_environment_identity(monkeypatch, missing):
    engine = engine_with_providers()
    engine.config = SimpleNamespace(providers={'yandex_realtime': {'api_key': 'yaml-key', 'folder_id': 'yaml-folder'}}, default_provider='yandex_realtime', pipelines={})
    engine.provider_alignment_issues = {}
    engine._audit_provider_config = lambda *args: []
    monkeypatch.setenv('YANDEX_CLOUD_API_KEY', 'test-env-key')
    monkeypatch.setenv('YANDEX_CLOUD_FOLDER_ID', 'test-env-folder')
    monkeypatch.delenv(missing)
    await engine._load_providers()
    assert 'yandex_realtime' not in engine.providers
    assert 'yandex_realtime' not in engine.provider_factories


@pytest.mark.asyncio
async def test_yandex_registered_factory_uses_env_and_clones_per_call(monkeypatch):
    engine = engine_with_providers()
    engine.config = SimpleNamespace(providers={'yandex_realtime': {'api_key': 'yaml-key', 'folder_id': 'yaml-folder'}}, default_provider='yandex_realtime', pipelines={})
    engine.provider_alignment_issues = {}
    engine._audit_provider_config = lambda *args: []
    engine._describe_provider_alignment = lambda *args: []
    engine.on_provider_event = lambda event: None
    engine.audio_gating_manager = None
    engine.session_store = object()
    monkeypatch.setenv('YANDEX_CLOUD_API_KEY', 'test-env-key')
    monkeypatch.setenv('YANDEX_CLOUD_FOLDER_ID', 'test-env-folder')
    await engine._load_providers()
    first = engine.provider_factories['yandex_realtime']()
    second = engine.provider_factories['yandex_realtime']()
    assert first is not second and first.config is not second.config
    assert first.config.api_key == 'test-env-key'
    assert first.config.folder_id == 'test-env-folder'
    first.config.instructions = 'tenant seven'
    assert second.config.instructions != 'tenant seven'
    assert engine.providers['yandex_realtime'].config.instructions != 'tenant seven'


@pytest.mark.parametrize('previous_voice', ['Aoede', 'alloy', 'denis'])
def test_switch_to_yandex_retains_compatible_default_for_previous_provider_voice(previous_voice):
    from src.config import YandexRealtimeProviderConfig
    from src.providers.yandex_realtime import YandexRealtimeProvider
    engine = engine_with_providers()
    provider = YandexRealtimeProvider(YandexRealtimeProviderConfig(), lambda event: None)
    call = session({'businessId': 7, 'voiceName': previous_voice})
    call.provider_overrides = {'voice_name': previous_voice, 'prompt': 'Tenant seven instructions'}
    engine._apply_provider_overrides(provider, call)
    assert provider.config.voice == 'sofia'
    assert provider.config.role == 'support'
    assert provider.config.instructions == 'Tenant seven instructions'
    assert provider._session_payload()['session']['audio']['output']['voice'] == 'sofia'


@pytest.mark.parametrize('chosen_voice', ['vera', 'irina', 'VASILY'])
def test_compatible_yandex_business_voice_is_applied(chosen_voice):
    from src.config import YandexRealtimeProviderConfig
    from src.providers.yandex_realtime import YandexRealtimeProvider
    engine = engine_with_providers()
    provider = YandexRealtimeProvider(YandexRealtimeProviderConfig(), lambda event: None)
    call = session({'businessId': 7})
    call.provider_overrides = {'voice_name': chosen_voice}
    engine._apply_provider_overrides(provider, call)
    assert provider.config.voice == chosen_voice.lower()
    assert provider.config.role == 'support'


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [TimeoutError("private ACK details"), RuntimeError("private provider details")])
async def test_startup_failure_stops_provider_saves_error_and_ends_call(failure):
    from unittest.mock import AsyncMock
    from src.core.models import CallSession
    engine = engine_with_providers('yandex_realtime')
    call = CallSession(call_id='failed-start', caller_channel_id='caller')
    call.business_id = 7
    call.hotel_profile = {'businessId': 7, 'voiceAiProvider': 'yandex_realtime'}
    provider = SimpleNamespace(config=SimpleNamespace(instructions=''),
        start_session=AsyncMock(side_effect=failure), stop_session=AsyncMock())
    engine.provider_factories['yandex_realtime'] = lambda: provider
    engine.config = SimpleNamespace(default_provider='yandex_realtime', audio_transport='audiosocket', tools={}, dict=lambda: {})
    engine.pipeline_orchestrator = SimpleNamespace(enabled=False)
    engine._call_providers = {}
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=call))
    saved = []
    async def save(current):
        saved.append((current.error_message, current.provider_session_active))
    engine._save_session = save
    engine._execute_pre_call_tools = AsyncMock(return_value={})
    engine._cleanup_call = AsyncMock()
    engine.conversation_coordinator = None
    engine.ari_client = SimpleNamespace(hangup_channel=AsyncMock())
    engine._apply_prompt_template_substitution = lambda prompt, current: prompt
    engine._append_hotel_profile_to_prompt = lambda prompt, current: prompt
    engine._append_scenario_pack_to_prompt = lambda prompt, current: prompt
    await engine._start_provider_session(call.call_id)
    provider.stop_session.assert_awaited_once()
    assert ('voice_provider_startup_failed', False) in saved
    assert call.error_message == 'voice_provider_startup_failed'
    assert call.call_id not in engine._call_providers
    engine.ari_client.hangup_channel.assert_awaited_once_with('caller')
    engine._cleanup_call.assert_awaited_once_with(call.call_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,existing_error,expected_error", [
    ('yandex_realtime', None, 'voice_provider_disconnected'),
    ('yandex_realtime', 'voice_provider_startup_failed', 'voice_provider_startup_failed'),
    ('google_live', None, None),
])
async def test_yandex_disconnect_saves_terminal_error_before_hangup(provider, existing_error, expected_error):
    from unittest.mock import AsyncMock
    from src.core.models import CallSession
    engine = engine_with_providers(provider)
    call = CallSession(call_id='disconnect', caller_channel_id='caller')
    call.provider_name = provider
    call.provider_session_active = True
    call.error_message = existing_error
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=call))
    events = []
    async def save(current):
        events.append(('saved', current.error_message, current.provider_session_active))
    async def hangup(channel):
        events.append(('hangup', channel))
    engine._save_session = save
    engine.config = SimpleNamespace(tools={})
    engine.ari_client = SimpleNamespace(hangup_channel=AsyncMock(side_effect=hangup))
    await engine.on_provider_event({'type': 'ProviderDisconnected', 'call_id': call.call_id,
        'provider': provider, 'reason': 'private raw customer/provider detail'})
    assert events == [('saved', expected_error, False), ('hangup', 'caller')]
    assert call.error_message == expected_error


@pytest.mark.parametrize("saved_voice", ['sofia', 'vera'])
def test_yandex_google_openai_rollback_keeps_voice_defaults_and_business_prompt(saved_voice):
    from src.config import YandexRealtimeProviderConfig, GoogleProviderConfig, OpenAIRealtimeProviderConfig
    engine = engine_with_providers()
    templates = {
        'yandex_realtime': YandexRealtimeProviderConfig(voice='sofia', instructions='Yandex baseline'),
        'google_live': GoogleProviderConfig(tts_voice_name='Aoede', instructions='Google baseline'),
        'openai_realtime': OpenAIRealtimeProviderConfig(voice='alloy', instructions='OpenAI baseline'),
    }
    profile = {'businessId': 7, 'voiceName': saved_voice, 'systemPrompt': 'Business seven saved instructions'}
    call = session(profile)
    call.provider_overrides = {'voice_name': saved_voice, 'prompt': profile['systemPrompt']}
    for selected, voice_field, expected_voice in [
        ('yandex_realtime', 'voice', saved_voice),
        ('google_live', 'tts_voice_name', 'Aoede'),
        ('openai_realtime', 'voice', 'alloy'),
    ]:
        call.provider_name = selected
        provider = SimpleNamespace(config=engine._clone_config(templates[selected]))
        engine._apply_provider_overrides(provider, call)
        assert getattr(provider.config, voice_field) == expected_voice
        assert provider.config.instructions == profile['systemPrompt']
        assert templates[selected].instructions != profile['systemPrompt']
        assert call.hotel_profile == profile
        assert call.provider_overrides['voice_name'] == saved_voice


def test_dict_google_config_ignores_known_yandex_voice_during_rollback():
    engine = engine_with_providers()
    call = session({'businessId': 7})
    call.provider_name = 'google_live'
    call.provider_overrides = {'voice_name': 'sofia', 'prompt': 'Business seven'}
    template = {'tts_voice_name': 'Aoede', 'instructions': 'Google baseline'}
    provider = SimpleNamespace(config=engine._clone_config(template))
    engine._apply_provider_overrides(provider, call)
    assert provider.config['tts_voice_name'] == 'Aoede'
    assert provider.config['instructions'] == 'Business seven'
    assert template == {'tts_voice_name': 'Aoede', 'instructions': 'Google baseline'}
