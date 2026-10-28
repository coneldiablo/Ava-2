import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from fastapi import FastAPI
from fastapi.testclient import TestClient

BACKEND=Path(__file__).resolve().parents[1]/'admin_ui'/'backend'
if str(BACKEND) not in sys.path: sys.path.insert(0,str(BACKEND))
spec=importlib.util.spec_from_file_location('customer_transcript_calls',BACKEND/'api'/'calls.py')
calls=importlib.util.module_from_spec(spec);spec.loader.exec_module(calls)

def test_transcript_http_requires_service_auth_exact_business_and_excludes_private_payloads(monkeypatch):
    record=SimpleNamespace(business_id=9,call_id='call-one',conversation_history=[
        {'role':'system','content':'private prompt'}, {'role':'user','content':'Пришлите подборку'},
        {'role':'assistant','content':'Передам менеджеру'}, {'role':'tool','content':'private tool args'},
        {'role':'assistant','content':{'api_key':'private'}}])
    class Store:
        async def get(self,record_id): return record if record_id=='record-one' else None
    monkeypatch.setattr(calls,'_get_call_history_store',lambda:Store())
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN','synthetic-test-service-token')
    app=FastAPI();app.include_router(calls.internal_router)
    with TestClient(app) as client:
        path='/internal/calls/business/9/record-one/transcript'
        assert client.get(path).status_code==401
        headers={'Authorization':'Bearer synthetic-test-service-token'}
        response=client.get(path,headers=headers)
        assert response.status_code==200
        assert response.json()['turns']==[{'role':'user','text':'Пришлите подборку'},{'role':'assistant','text':'Передам менеджеру'}]
        assert 'private' not in response.text
        assert client.get('/internal/calls/business/1/record-one/transcript',headers=headers).status_code==404
        assert client.get('/internal/calls/business/9/missing/transcript',headers=headers).status_code==404
