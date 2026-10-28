"""Fixture-only checks for the source recovered from the deployed native API."""
import asyncio
import copy
import uuid

import pytest

from native_modules.onyx.auth.core import Denied
from native_modules.onyx.auth.knowledge_api import KnowledgeAPI


@pytest.fixture
def api_fixture():
    deployment = str(uuid.uuid4())
    users = [str(uuid.uuid4()), str(uuid.uuid4())]
    class Config:
        business_id, deployment_id, namespace = 4, deployment, "ava_" + deployment.replace("-", "")
        def native_id(self, ava_id): return str(uuid.uuid5(uuid.UUID(deployment), "ava-user:" + ava_id))
    config = Config()
    class State:
        enabled, revision = 1, 3
        def contour(self): return {"enabled": self.enabled, "business_id": 4, "deployment_id": deployment,
                                   "namespace": config.namespace, "revision": self.revision}
        def user(self, user): return {"state": "active", "revision": self.revision, "native_user_id": config.native_id(user)} if user in users else None
    state = State()
    class Session:
        commits, rollbacks = 0, 0
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def commit(self): self.commits += 1
        def rollback(self): self.rollbacks += 1
    session = Session()
    payload = {"businessId": 4, "deploymentId": deployment, "nativeScope": config.namespace, "revision": 3,
               "ownerUserId": users[0], "runtimeUserId": users[1], "ownerCcPairId": 11, "runtimeCcPairId": 12, "documentSetId": 13,
               "document": {"id": "ava:4:knowledge:7", "source_id": "7", "content_hash": "a" * 32,
                            "title": "SYNTHETIC own", "text": "SYNTHETIC business4 content"}}
    return config, state, session, payload


@pytest.mark.parametrize("mutate", [lambda p: p.update(businessId=9), lambda p: p.update(revision=4),
    lambda p: p.update(ownerUserId=str(uuid.uuid4())), lambda p: p.update(runtimeCcPairId=11),
    lambda p: p["document"].update(id="ava:9:knowledge:7"), lambda p: p.update(command="anything")])
def test_invalid_native_scope_never_runs_ingestion(api_fixture, mutate):
    config, state, session, payload = api_fixture
    mutate(payload)
    api = KnowledgeAPI(config, state, session_factory=lambda: session,
                       ingest=lambda *_a, **_k: pytest.fail("invalid scope indexed"))
    with pytest.raises(Denied): asyncio.run(api.upsert_knowledge(payload))
    assert session.commits == 0


def test_native_ingestion_commit_is_durable_and_precommit_fenced(api_fixture):
    config, state, session, payload = api_fixture
    observed = []
    def ingest(_db, **kwargs):
        observed.append(kwargs); return {"document_id": kwargs["document"]["id"]}
    api = KnowledgeAPI(config, state, session_factory=lambda: session, ingest=ingest)
    assert asyncio.run(api.upsert_knowledge(payload)) == {"document_id": "ava:4:knowledge:7"}
    assert session.commits == 1 and observed[0]["runtime_user_id"] == config.native_id(payload["runtimeUserId"])
    def revoke_during_index(_db, **_kwargs):
        state.enabled = 0; return {"document_id": "ava:4:knowledge:7"}
    api.ingest = revoke_during_index
    with pytest.raises(Denied): asyncio.run(api.upsert_knowledge(payload))
    assert session.commits == 1 and session.rollbacks == 1
