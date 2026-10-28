"""Execute actual provider with synthetic transports, no network or database."""
import asyncio
import copy
import json
import struct
from types import SimpleNamespace
from src.providers.neuro_gemini import NeuroGeminiProvider

class Speech:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = None
        self.closed = False
    async def start_asr(self, callback):
        self.callback = callback
    async def send_audio(self, *args, **kwargs):
        pass
    async def synthesize(self, text, voice):
        self.started.set()
        if self.release:
            await self.release.wait()
        yield b'\x01\x01' * 320
    async def close(self):
        self.closed = True

class Vertex:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []
        self.closed = False
    async def stream(self, history, **kwargs):
        self.requests.append(copy.deepcopy(history))
        for event in self.responses[len(self.requests)-1]:
            if isinstance(event, asyncio.Event):
                await event.wait()
            else:
                yield event
    async def close(self):
        self.closed = True

def answer(text='Synthetic reply.'):
    return [{'type':'text','text':text},{'type':'content','content':{'role':'model','parts':[{'text':text}]}}]

async def setup(responses):
    config = SimpleNamespace(api_key='synthetic',project_id='synthetic-project',model='gemini-3.8-flash',
        voice_name='edsel',input_encoding='pcm16',input_sample_rate_hz=16000,
        target_encoding='pcm16',target_sample_rate_hz=16000)
    events, speech, vertex = [], Speech(), Vertex(responses)
    provider = NeuroGeminiProvider(config, events.append)
    provider._new_speech = lambda:speech
    provider._new_vertex = lambda:vertex
    await provider.start_session('synthetic-release-check')
    return provider,speech,vertex,events

async def main():
    results = []
    release = asyncio.Event()
    p,s,v,e = await setup([[release,*answer()]])
    try:
        await s.callback({'type':'final','text':'Synthetic question'})
        while not v.requests:
            await asyncio.sleep(0)
        task, generation = p._turn_task,p._generation
        e.clear()
        await p.send_audio(struct.pack('<h',2000)*1280)
        await p.send_audio(bytes(12800))
        assert p._turn_task is task and not task.done() and p._generation==generation
        assert not any(x['type']=='ProviderBargeIn' for x in e)
        release.set()
        await asyncio.wait_for(task,2)
        assert any(x['type']=='AgentAudio' for x in e)
        results.append('noise_during_model_preserves_answer')
    finally:
        await p.stop_session()
    assert s.closed and v.closed
    results.append('transports_close_after_noise')

    p,s,v,e = await setup([answer('Old answer.'),answer('New answer.')])
    try:
        s.release = asyncio.Event()
        await s.callback({'type':'final','text':'First question'})
        await asyncio.wait_for(s.started.wait(),1)
        task,generation = p._turn_task,p._generation
        await p.send_audio(struct.pack('<h',2000)*1280)
        assert p._turn_task is task and not task.done()
        results.append('noise_during_tts_preserves_answer')
        await s.callback({'type':'partial','text':'New question'})
        assert task.cancelled()
        await p._emit('AgentAudio',generation=generation,data=b'late')
        assert not any(x['type']=='AgentAudio' for x in e)
        s.release.set()
        e.clear()
        await s.callback({'type':'final','text':'New question'})
        await asyncio.wait_for(p._turn_task,2)
        assert any(x['type']=='AgentAudio' for x in e)
        assert all(x['text']=='New answer.' for x in e if x['type']=='agent_transcript')
        results.append('recognized_barge_in_flushes_and_replaces_old_answer')
    finally:
        await p.stop_session()

    p,s,v,e = await setup([answer() for _ in range(20)])
    try:
        for n in range(20):
            await s.callback({'type':'final','text':f'Synthetic question {n}'})
            await p.send_audio(struct.pack('<h',2000)*1280)
            await p.send_audio(bytes(12800))
            await asyncio.wait_for(p._turn_task,2)
        assert len(v.requests)==20
        assert len([x for x in e if x['type']=='AgentAudio'])==20
        assert len([x for x in p._history if x['role']=='user'])==20
        assert not any(x['type']=='ProviderError' for x in e)
        results.append('twenty_noisy_turns_preserve_all_answers_and_context')
    finally:
        await p.stop_session()
    print(json.dumps({'passed':len(results),'checks':results,'network':False,'realCall':False}))

asyncio.run(main())
