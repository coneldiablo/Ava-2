import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from src.providers.yandex_realtime import YandexRealtimeProvider, ENDPOINT


def provider(**overrides):
    config = dict(api_key='test-key', folder_id='test-folder', instructions='base',
                  input_encoding='ulaw', input_sample_rate_hz=8000,
                  provider_input_sample_rate_hz=24000, output_sample_rate_hz=24000,
                  target_encoding='ulaw', target_sample_rate_hz=8000)
    config.update(overrides)
    events = []
    async def emit(event):
        events.append(event)
    p = YandexRealtimeProvider(SimpleNamespace(**config), emit)
    p._call_id = 'test-call'
    p._closing = False
    p.websocket = SimpleNamespace(closed=False, send_json=AsyncMock(), close=AsyncMock())
    return p, events


def test_current_nested_protocol_and_prompt_override():
    p, _ = provider()
    p._context = {'instructions': 'tenant prompt', 'tools': []}
    session = p._session_payload()['session']
    assert session['type'] == 'realtime'
    assert session['instructions'] == 'tenant prompt'
    assert session['output_modalities'] == ['audio']
    assert session['audio']['input']['format'] == {'type': 'audio/pcm', 'rate': 24000}
    assert session['audio']['output']['voice'] == 'sofia'
    assert session['audio']['output']['role'] == 'support'
    assert 'input_audio_format' not in session
    assert session['tools'] == []


@pytest.mark.parametrize('voice,role', [('dasha', 'neutral'), ('sofia', 'general'), ('sergey','casual')])
def test_incompatible_voice_rejected(voice, role):
    p, _ = provider(voice=voice, role=role)
    with pytest.raises(ValueError):
        p._session_payload()


@pytest.mark.asyncio
async def test_ulaw_to_pcm_and_return_audio_contract():
    p, events = provider()
    await p.send_audio(b'\xff' * 160)
    append = p.websocket.send_json.call_args.args[0]
    assert append['type'] == 'input_audio_buffer.append'
    assert len(base64.b64decode(append['audio'])) == 960
    await p._handle_event({'type':'response.created', 'response':{'id':'r1'}})
    await p._handle_event({'type':'response.output_audio.delta', 'response_id':'r1',
                           'delta':base64.b64encode(b'\x00\x00' * 480).decode()})
    assert events[-1]['type'] == 'AgentAudio'
    assert len(events[-1]['data']) == 160
    assert events[-1]['encoding'] == 'ulaw'
    assert events[-1]['sample_rate'] == 8000


@pytest.mark.asyncio
async def test_interruption_discards_late_audio_and_old_done():
    p, events = provider()
    await p._handle_event({'type':'response.created','response':{'id':'r1'}})
    await p._handle_event({'type':'input_audio_buffer.speech_started'})
    await p._handle_event({'type':'response.created','response':{'id':'r2'}})
    await p._handle_event({'type':'response.output_audio.delta','response_id':'r1','delta':'AAAA'})
    await p._handle_event({'type':'response.output_audio.done','response_id':'r1'})
    assert [e['type'] for e in events] == ['ProviderBargeIn','AgentAudioDone']
    await p.cancel_response()
    assert p.websocket.send_json.call_args.args[0] == {'type':'response.cancel'}
    assert p._response_id is None


@pytest.mark.asyncio
async def test_tool_duplicate_and_durable_executor_result_not_promoted():
    p, _ = provider()
    executor = AsyncMock(return_value={'status':'queued','durable':False})
    p._context = {'tools':['save'], 'business_id':27, 'tool_executor':executor}
    tool = SimpleNamespace(execute=AsyncMock())
    event = {'type':'response.output_item.done','item':{
        'type':'function_call','call_id':'fn1','name':'save','arguments':'{"value":42}'}}
    with patch('src.providers.yandex_realtime.tool_registry.is_tool_allowed', return_value=True), \
         patch('src.providers.yandex_realtime.tool_registry.get', return_value=tool), \
         patch('src.providers.yandex_realtime.ToolExecutionContext.get_tool_block_response', new=AsyncMock(return_value=None)):
        await p._handle_event(event)
        await p._handle_event(event)
        await p._tool_tasks['fn1']
    executor.assert_awaited_once()
    args = executor.call_args
    assert args.args[2].business_id == 27
    assert args.kwargs['idempotency_key'] == 'yandex:test-call:fn1'
    assert not tool.execute.called
    payload = p.websocket.send_json.call_args_list[0].args[0]
    assert payload['type'] == 'conversation.item.create'
    assert json.loads(payload['item']['output'])['status'] == 'queued'
    assert p.websocket.send_json.call_args_list[1].args[0] == {'type':'response.create'}


@pytest.mark.asyncio
async def test_invalid_tool_json_never_executes():
    p, _ = provider()
    executor = AsyncMock()
    p._context = {'tools':['save'], 'tool_executor':executor}
    await p._execute_tool({'call_id':'bad', 'name':'save', 'arguments':'not json'})
    assert not executor.called
    result = json.loads(p.websocket.send_json.call_args_list[0].args[0]['item']['output'])
    assert result['status'] == 'error'


@pytest.mark.asyncio
async def test_protocol_error_never_emits_raw_secret():
    p, events = provider()
    await p._handle_event({'type':'error','error':{'message':'test-key private prompt'}})
    assert events == [{'type':'ProviderError','call_id':'test-call','error':'yandex_protocol_error'}]
    assert p._startup_error


@pytest.mark.asyncio
async def test_direct_transport_headers_and_cleanup(monkeypatch):
    p, _ = provider()
    ws = SimpleNamespace(closed=False,send_json=AsyncMock(),close=AsyncMock())
    http = SimpleNamespace(ws_connect=AsyncMock(return_value=ws),close=AsyncMock())
    async def receive():
        p._ready.set()
        await asyncio.Event().wait()
    p._receive = receive
    monkeypatch.setenv('HTTP_PROXY','http://invalid-proxy')
    monkeypatch.setenv('AI_PROVIDER_PROXY_URL','http://invalid-proxy')
    with patch('src.providers.yandex_realtime.aiohttp.ClientSession',return_value=http) as factory:
        await p.start_session('new', {'tools':[]})
        factory.assert_called_once_with(trust_env=False)
        kwargs = http.ws_connect.call_args.kwargs
        assert kwargs['proxy'] is None
        assert kwargs['headers'] == {'Authorization':'Api-Key test-key','x-folder-id':'test-folder'}
        assert http.ws_connect.call_args.args[0].startswith(ENDPOINT+'?model=')
        assert 'speech-realtime-max-tts-live' in http.ws_connect.call_args.args[0]
        await p.stop_session()
        assert p.websocket is None
        ws.close.assert_awaited_once()
        http.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_connect_closes_client():
    p, _ = provider()
    http = SimpleNamespace(ws_connect=AsyncMock(side_effect=RuntimeError('failed')),close=AsyncMock())
    with patch('src.providers.yandex_realtime.aiohttp.ClientSession',return_value=http):
        with pytest.raises(RuntimeError):
            await p.start_session('new')
    http.close.assert_awaited_once()
    assert p._closing

@pytest.mark.asyncio
async def test_engine_recoded_pcm_metadata_overrides_ulaw_config():
    p, _ = provider()
    p.set_input_mode('mulaw8k')
    await p.send_audio(b'\x00\x00' * 480, sample_rate=24000, encoding='linear16')
    payload = p.websocket.send_json.call_args.args[0]
    assert base64.b64decode(payload['audio']) == b'\x00\x00' * 480


@pytest.mark.asyncio
async def test_engine_pcm_input_mode():
    p, _ = provider()
    p.set_input_mode('pcm16_16k')
    await p.send_audio(b'\x00\x00' * 320)
    assert len(base64.b64decode(p.websocket.send_json.call_args.args[0]['audio'])) == 960


@pytest.mark.asyncio
async def test_transcript_dedup_engine_owns_history():
    p, events = provider()
    session = SimpleNamespace(conversation_history=[])
    p._session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session),upsert_call=AsyncMock())
    event = {'type':'response.output_text.done','item_id':'i1','text':'hello'}
    await p._handle_event(event)
    await p._handle_event(event)
    assert len(events) == 1
    assert events[0]['type'] == 'agent_transcript'
    assert session.conversation_history == []
    p._session_store.upsert_call.assert_not_awaited()

@pytest.mark.asyncio
@pytest.mark.parametrize('event', [
    {'type':'error','error':{'message':'secret'}},
    {'type':'response.done','response':{'id':'r1','status':'failed'}},
    {'type':'response.done','response':{'id':'r1','status':'incomplete'}},
])
async def test_fatal_ready_errors_disconnect_once_and_close(event):
    p, events = provider()
    p._ready.set()
    ws = p.websocket
    await p._handle_event(event)
    assert sum(e['type'] == 'ProviderDisconnected' for e in events) == 1
    assert p._closing
    ws.close.assert_awaited_once()
    await p._disconnect('second')
    assert sum(e['type'] == 'ProviderDisconnected' for e in events) == 1


@pytest.mark.asyncio
async def test_tool_timeout_returns_unconfirmed_outcome_and_continues():
    p, _ = provider(tool_timeout_seconds=0.01)
    p._context = {'tools':['save']}
    async def hung(*args):
        await asyncio.Event().wait()
    tool = SimpleNamespace(execute=hung)
    with patch('src.providers.yandex_realtime.tool_registry.is_tool_allowed', return_value=True), \
         patch('src.providers.yandex_realtime.tool_registry.get', return_value=tool), \
         patch('src.providers.yandex_realtime.ToolExecutionContext.get_tool_block_response', new=AsyncMock(return_value=None)):
        await p._execute_tool({'call_id':'slow', 'name':'save', 'arguments':'{}'})
    result = json.loads(p.websocket.send_json.call_args_list[0].args[0]['item']['output'])
    assert result['code'] == 'tool_timeout'
    assert result['outcome'] == 'unknown'
    assert result['status'] == 'error'
    assert p.websocket.send_json.call_args_list[1].args[0] == {'type':'response.create'}

@pytest.mark.asyncio
async def test_tool_history_keeps_real_status_without_sensitive_payload():
    p, _ = provider()
    session = SimpleNamespace(tool_calls=[])
    p._session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session),upsert_call=AsyncMock())
    await p._record_tool('save','fn1',{'status':'queued','message':'private details'},0)
    record = session.tool_calls[0]
    assert record['result'] == 'queued'
    assert record['params'] == {}
    assert record['message'] == ''
    assert record['duration_ms'] >= 0
    p._session_store.upsert_call.assert_awaited_once()

@pytest.mark.parametrize('overrides', [
    {'api_key':''}, {'folder_id':''}, {'enabled':False}, {'model':'other'},
    {'voice':'dasha'}, {'role':'general'}, {'output_sample_rate_hz':123},
    {'input_encoding':'unsupported'}, {'target_sample_rate_hz':0},
])
def test_readiness_rejects_missing_or_invalid_configuration(overrides):
    p, _ = provider(**overrides)
    assert not p.is_ready()


def test_readiness_is_configured_availability_without_active_connection():
    p, _ = provider()
    p.websocket = None
    assert p.is_ready()

@pytest.mark.asyncio
async def test_tool_output_and_continuation_do_not_wait_for_response_done():
    p, _ = provider()
    p._context = {'tools':['save'], 'business_id':27, 'tool_executor':AsyncMock(return_value={'status':'success','message':'Сохранено'})}
    p._response_id = 'native-response'
    item={'type':'response.output_item.done','response_id':'native-response','item':{'type':'function_call','call_id':'first','name':'save','arguments':'{}'}}
    with patch('src.providers.yandex_realtime.tool_registry.is_tool_allowed',return_value=True), patch('src.providers.yandex_realtime.tool_registry.get',return_value=SimpleNamespace()), patch('src.providers.yandex_realtime.ToolExecutionContext.get_tool_block_response',new=AsyncMock(return_value=None)):
        await p._handle_event(item)
        await p._tool_tasks['first']
    sent=[c.args[0] for c in p.websocket.send_json.call_args_list]
    assert [v['type'] for v in sent] == ['conversation.item.create','response.create']
    await p._handle_event({'type':'response.done','response':{'id':'native-response','status':'completed'}})
    assert p.websocket.send_json.call_count == 2


@pytest.mark.asyncio
async def test_parallel_completed_function_outputs_have_one_continuation():
    p, _ = provider()
    release=asyncio.Event()
    async def execute(name,args,context,**kwargs):
        await release.wait()
        return {'status':'success','message':'Сохранено'}
    p._context={'tools':['save'],'business_id':27,'tool_executor':execute}
    p._response_id='batch'
    with patch('src.providers.yandex_realtime.tool_registry.is_tool_allowed',return_value=True), patch('src.providers.yandex_realtime.tool_registry.get',return_value=SimpleNamespace()), patch('src.providers.yandex_realtime.ToolExecutionContext.get_tool_block_response',new=AsyncMock(return_value=None)):
        for invocation in ['a','b']:
            await p._handle_event({'type':'response.output_item.done','response_id':'batch','item':{'type':'function_call','call_id':invocation,'name':'save','arguments':'{}'}})
        release.set()
        await asyncio.gather(*p._tool_tasks.values())
    sent=[c.args[0] for c in p.websocket.send_json.call_args_list]
    assert [v['type'] for v in sent] == ['conversation.item.create','conversation.item.create','response.create']

@pytest.mark.asyncio
@pytest.mark.parametrize('transcript_first',[True,False])
@pytest.mark.parametrize('caller_text,expected', [('Всё, спасибо', 1), ('Спасибо', 0)])
async def test_native_mutual_goodbye_waits_for_audio_and_transcript(transcript_first,caller_text,expected):
    p,events=provider()
    p._context={'tools':['hangup_call']}
    await p._handle_event({'type':'conversation.item.input_audio_transcription.completed','item_id':'u','transcript':caller_text})
    await p._handle_event({'type':'response.created','response':{'id':'bye'}})
    await p._handle_event({'type':'response.output_audio.delta','response_id':'bye','delta':base64.b64encode(b'\x00\x00'*480).decode()})
    transcript={'type':'response.output_audio_transcript.done','response_id':'bye','transcript':'Пожалуйста! Хорошего дня!'}
    done={'type':'response.output_audio.done','response_id':'bye'}
    await p._handle_event(transcript if transcript_first else done)
    assert not any(e['type']=='HangupReady' for e in events)
    await p._handle_event(done if transcript_first else transcript)
    assert sum(e['type']=='HangupReady' for e in events)==expected
    await p._handle_event(done)
    assert sum(e['type']=='HangupReady' for e in events)==expected


@pytest.mark.asyncio
async def test_native_continued_question_invalidates_old_goodbye():
    p,events=provider()
    p._context={'tools':['hangup_call']}
    await p._handle_event({'type':'conversation.item.input_audio_transcription.completed','item_id':'u','transcript':'До свидания'})
    await p._handle_event({'type':'response.created','response':{'id':'bye'}})
    await p._handle_event({'type':'response.output_audio.delta','response_id':'bye','delta':base64.b64encode(b'\x00\x00'*480).decode()})
    await p._handle_event({'type':'input_audio_buffer.speech_started'})
    await p._handle_event({'type':'conversation.item.input_audio_transcription.completed','item_id':'u2','transcript':'Подождите, ещё вопрос'})
    await p._handle_event({'type':'response.output_audio_transcript.done','response_id':'bye','transcript':'До свидания'})
    await p._handle_event({'type':'response.output_audio.done','response_id':'bye'})
    assert not any(e['type']=='HangupReady' for e in events)

@pytest.mark.asyncio
async def test_native_goodbye_preserves_inflight_business_action():
    p, events=provider()
    p._context={'tools':['hangup_call']}
    p._last_user_text='До свидания'
    p._response_generations['bye']=p._closing_generation
    p._response_texts['bye']='До свидания'
    p._audio_completed.add('bye')
    release=asyncio.Event()
    task=asyncio.create_task(release.wait())
    p._tool_tasks['send']=task
    await p._maybe_finish_closing('bye')
    assert not any(e['type']=='HangupReady' for e in events)
    release.set()
    await task
    await p._maybe_finish_closing('bye')
    assert sum(e['type']=='HangupReady' for e in events)==1
