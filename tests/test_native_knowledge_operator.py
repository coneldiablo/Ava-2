"""Root operator/verifier contracts only; live native probes are not run."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import onyx_native_verifier as verifier
from module_deployment_helper import DeploymentError


spec = importlib.util.spec_from_file_location("ava_native_bootstrap_fixture", ROOT / "scripts/bootstrap-onyx-native-knowledge.py")
bootstrap = importlib.util.module_from_spec(spec); spec.loader.exec_module(bootstrap)


def test_recovered_native_source_hashes_match_readonly_production_evidence():
    provenance = json.loads((ROOT / "deploy/onyx/native-knowledge-source-provenance.json").read_text())
    for name, digest in provenance["recoveredFilesSha256"].items():
        assert hashlib.sha256((ROOT / "native_modules/onyx" / name).read_bytes()).hexdigest() == digest


@pytest.fixture
def operator(tmp_path, monkeypatch):
    deployment = str(uuid.uuid4()); owner = str(uuid.uuid4())
    scope = {"businessId": 4, "deploymentId": deployment, "namespace": "ava_" + deployment.replace("-", ""),
             "revision": 3, "module": "onyx", "hostname": "synthetic-4.knowledge.meludtech.tech", "sourceCommit": "synthetic"}
    foreign_id = str(uuid.uuid4())
    manifest = {"schemaVersion": 1, "kind": "ava_onyx_customer_entry_operator", "businessId": 4,
                "deploymentId": deployment, "nativeScope": scope["namespace"], "revision": 3,
                "principal": {"userId": owner, "subject": "synthetic-owner", "role": "hotel_owner"},
                "foreignScope": {"businessId": 9, "deploymentId": foreign_id, "nativeScope": "ava_" + foreign_id.replace("-", ""), "revision": 1}}
    config = {"businessId": 4, "deploymentId": deployment, "nativeScope": scope["namespace"], "revision": 3,
              "ownerUserId": owner, "modelConfigurationId": 14, "providerId": 15,
              "providerApiBase": "https://wh.meludtech.tech/api/integrations/onyx/llm", "modelName": "ava-hotel-4"}
    database = tmp_path / "crm.sqlite"
    with sqlite3.connect(database) as db:
        db.executescript("""CREATE TABLE instances(id INTEGER,isActive INTEGER);
            CREATE TABLE ava_users(id TEXT,subject TEXT,enabled INTEGER);
            CREATE TABLE ava_business_memberships(userId TEXT,businessId INTEGER,role TEXT,enabled INTEGER);
            CREATE TABLE ava_module_deployments(id TEXT,businessId INTEGER,module TEXT,state TEXT,revision INTEGER,namespace TEXT);
            CREATE TABLE knowledge_base(id INTEGER,instanceId INTEGER,business_id INTEGER,originalName TEXT,contentHash TEXT,version INTEGER,isCurrent INTEGER,content TEXT);
            CREATE TABLE kb_chunks(id INTEGER,kbId INTEGER,chunkIndex INTEGER,text TEXT);
            CREATE TABLE ava_module_adapters(id TEXT,revision INTEGER,integrationId TEXT,integrationRevision INTEGER,deploymentRevision INTEGER,peerSecretHash TEXT,
                businessId INTEGER,module TEXT,enabled INTEGER,deploymentId TEXT,nativeScope TEXT,attachmentMode TEXT,attachmentModeV2 TEXT);
            CREATE TABLE onyx_tenant_links(id TEXT,business_id INTEGER,revision INTEGER,status TEXT,onyx_tenant_id TEXT);
            INSERT INTO instances VALUES(4,1);
            INSERT INTO knowledge_base VALUES(7,4,4,'SYNTHETIC','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,NULL);
            INSERT INTO kb_chunks VALUES(1,7,0,'SYNTHETIC canonical content');""")
        db.execute("INSERT INTO ava_users VALUES(?,?,1)", (owner, "synthetic-owner"))
        db.execute("INSERT INTO ava_business_memberships VALUES(?,4,'hotel_owner',1)", (owner,))
        db.execute("INSERT INTO ava_module_deployments VALUES(?,4,'onyx','verified',3,?)", (deployment, scope["namespace"]))
        db.execute("INSERT INTO onyx_tenant_links VALUES('anchor',4,2,'STAGING',?)", (scope["namespace"],))
        db.execute("INSERT INTO ava_module_adapters VALUES(?,1,'anchor',2,3,?,4,'onyx',1,?,?,'existing_workspace_ui','isolated_workspace_ui')",
                   (deployment, "a" * 64, deployment, scope["namespace"]))
    monkeypatch.setattr(verifier, "private_json", lambda _path: (b"", manifest))
    return tmp_path, scope, manifest, config, database


def test_native_verifier_manifest_requires_current_enabled_owner_and_foreign_scope(operator):
    root, scope, manifest, _config, database = operator
    _own, actual, foreign = verifier.load_operator(root, scope, database)
    assert actual["businessId"] == 4 and foreign["businessId"] == 9
    manifest["principal"]["subject"] = "foreign-owner"
    with pytest.raises(DeploymentError): verifier.load_operator(root, scope, database)
    manifest["principal"]["subject"] = "synthetic-owner"
    with sqlite3.connect(database) as db: db.execute("UPDATE ava_business_memberships SET enabled=0")
    with pytest.raises(DeploymentError): verifier.load_operator(root, scope, database)


def test_native_verifier_does_not_accept_user_supplied_proof_flags(operator):
    root, scope, manifest, _config, database = operator
    manifest["nativeIdentityVerified"] = True
    with pytest.raises(DeploymentError, match="CONFIGURATION_REQUIRED"): verifier.load_operator(root, scope, database)


@pytest.mark.parametrize("mutate", [lambda c: c.update(providerApiBase="https://api.aitunnel.ru/v1"),
    lambda c: c.update(providerApiBase="https://credential@wh.meludtech.tech/api/integrations/onyx/llm"),
    lambda c: c.update(modelName="ava-hotel-9"), lambda c: c.update(businessId=True), lambda c: c.update(api_key="forbidden")])
def test_bootstrap_refuses_direct_provider_keys_foreign_alias_and_untrusted_config_fields(operator, monkeypatch, mutate):
    root, _scope, _manifest, config, _database = operator
    mutate(config); monkeypatch.setattr(bootstrap, "private_json", lambda _path: (b"", config))
    with pytest.raises(DeploymentError): bootstrap.load_config(root / "config.json")


def test_bootstrap_plan_reads_own_sources_without_native_calls_or_token_read(operator, monkeypatch):
    root, scope, _manifest, config, database = operator
    recipe = {"businessId": 4, "deploymentId": scope["deploymentId"], "revision": 3, "namespace": scope["namespace"]}
    def private(path):
        if path.name == "bootstrap.json": return b"", config
        if path.name == "recipe.json": return b"", recipe
        if path.name == "compose.json": return b"", {"services": {"knowledge-api": {}}}
        pytest.fail("dry-run read credential material")
    monkeypatch.setattr(bootstrap, "private_json", private)
    monkeypatch.setattr(bootstrap, "execute", lambda *_args, **_kwargs: pytest.fail("dry-run contacted native contour"))
    assert bootstrap.prepare(config_path=root / "bootstrap.json", crm_db=database, recipes=root) == {
        "businessId": 4, "sources": 1, "dryRun": True, "sourceKnowledgeVerified": False}
    assert not (root / scope["deploymentId"]).exists()


def test_initial_native_binding_tuple_changes_on_peer_rotation_or_integration_revision(operator):
    _root, _scope, _manifest, config, database = operator
    initial = bootstrap.current_binding(database, config)
    assert initial["deploymentRevision"] == 3 and initial["integrationRevision"] == 2
    with sqlite3.connect(database) as db: db.execute("UPDATE ava_module_adapters SET peerSecretHash=?", ("b" * 64,))
    assert bootstrap.current_binding(database, config) != initial
    with sqlite3.connect(database) as db: db.execute("UPDATE onyx_tenant_links SET revision=3")
    with pytest.raises(DeploymentError): bootstrap.current_binding(database, config)


def test_bootstrap_chunk_receipt_cannot_substitute_for_live_index_metadata():
    documents = [{"source_id": "7", "native_id": "ava%3A4%3Aknowledge%3A7", "content_hash": "a" * 32}]
    expected = {"indexReadinessVerified": True, "indexProbeMethod": "default_document_index_random_acl_v1",
        "indexedDocuments": {"ava:4:knowledge:7": {"onyx_document_id": documents[0]["native_id"], "source_id": "7", "content_hash": "a" * 32}}}
    assert bootstrap.validate_index_readback(expected, documents, 4) == expected
    for value in [{"sourceKnowledgeVerified": True}, {**expected, "indexedDocuments": {}},
                  {**expected, "indexProbeMethod": "chunk-info"}, {**expected, "indexReadinessVerified": False}]:
        with pytest.raises(DeploymentError): bootstrap.validate_index_readback(value, documents, 4)


def test_periodic_private_container_transport_handles_edit_and_last_source_delete(operator, monkeypatch):
    root, scope, _manifest, cfg, database = operator
    spec = importlib.util.spec_from_file_location("ava_native_periodic_fixture", ROOT / "scripts/sync-onyx-native-knowledge.py")
    periodic = importlib.util.module_from_spec(spec); spec.loader.exec_module(periodic)
    prepared = root / scope["deploymentId"]; output = prepared / "config"; output.mkdir(parents=True)
    config = {key: cfg[key] for key in ("businessId", "deploymentId", "nativeScope", "revision", "ownerUserId")}
    config.update(runtimeUserId=str(uuid.uuid4()), ownerCcPairId=11, runtimeCcPairId=12, documentSetId=13)
    binding = {"owner_cc_pair_id": 11, "runtime_cc_pair_id": 12, "document_set_id": 13, "persona_id": 14,
               "search_tool_id": 1, "document_set_name": "ava-native-" + scope["deploymentId"].replace("-", "") + "-knowledge"}
    for filename, value in [("config/knowledge-reconcile.json", config), ("recipe.json", {
        "businessId": 4, "deploymentId": scope["deploymentId"], "namespace": scope["namespace"], "revision": 3}),
        ("compose.json", {"services": {"knowledge-api": {"image": "synthetic@sha256:" + "a" * 64}, "api": {"image": "synthetic@sha256:" + "a" * 64}}}),
        ("config/knowledge-bootstrap-receipt.json", {**config, "binding": binding})]:
        target = prepared / filename; target.write_text(json.dumps(value)); target.chmod(0o600)
    key = output / "knowledge-reconcile.key"; key.write_text("S" * 43); key.chmod(0o600)
    monkeypatch.setattr(periodic, "private_json", lambda path: (b"", json.loads(path.read_text())))
    monkeypatch.setattr(periodic.projection, "read_root_json", lambda path: json.loads(path.read_text()))
    contacts = []
    old_index = []
    def container(current_scope, service, image):
        assert current_scope == {k: config[k] for k in ("businessId", "deploymentId", "nativeScope", "revision")}
        assert service in ("knowledge-api", "api") and image.startswith("synthetic@sha256:")
        contacts.append(service); return "exact-own-labelled-container-" + service
    def execute(container, code, payload, timeout):
        if code == periodic.bootstrap.INDEX_RETRIEVAL:
            assert container == "exact-own-labelled-container-api" and payload["scope"]["businessId"] == 4
            return {"indexReadinessVerified": True, "indexProbeMethod": "default_document_index_random_acl_v1",
                    "indexedDocuments": {"ava:4:knowledge:" + item["source_id"]: {
                        "onyx_document_id": item["native_id"], "source_id": item["source_id"],
                        "content_hash": "a" * 32 if old_index else item["content_hash"]} for item in payload["documents"]}}
        assert container == "exact-own-labelled-container-knowledge-api" and code == periodic.bootstrap.KNOWLEDGE_REQUEST
        assert payload["body"]["businessId"] == 4 and payload["body"]["deploymentId"] == scope["deploymentId"]
        contacts.append(payload["path"])
        return {"document_id": payload["body"].get("document", {}).get("id", payload["body"].get("documentId")), "deleted": True}
    monkeypatch.setattr(periodic, "container_for", container)
    monkeypatch.setattr(periodic.bootstrap, "execute", execute)
    args = {"recipes": root, "deployment_id": scope["deploymentId"], "crm_db": database}
    assert periodic.catch_up(**args)["upserted"] == 1 and contacts == []
    assert periodic.catch_up(**args, run=True)["projected"] == 1
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO onyx_native_runtime_document_links VALUES('foreign-deployment',1,9,'knowledge',8,'foreign-id',?)", ("b" * 32,))
        db.execute("UPDATE knowledge_base SET contentHash=?,version=2 WHERE id=7", ("c" * 32,))
        db.execute("UPDATE kb_chunks SET text='SYNTHETIC revised' WHERE kbId=7")
    old_index.append(True)
    with pytest.raises(DeploymentError): periodic.catch_up(**args, run=True)
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT content_hash FROM onyx_native_runtime_document_links WHERE business_id=4").fetchone() == ("a" * 32,)
    old_index.clear()
    # The previous indexing ACK advanced its durable checkpoint. Retry must
    # still probe the live current index before publishing the new projection.
    assert periodic.catch_up(**args, run=True)["unchanged"] == 1
    with sqlite3.connect(database) as db: db.execute("DELETE FROM kb_chunks WHERE kbId=7")
    result = periodic.catch_up(**args, run=True)
    assert result["deleted"] == 1 and result["projected"] == 0 and result["searchabilityVerified"] is False
    assert periodic.catch_up(**args, run=True)["deleted"] == 0
    assert "/v1/knowledge/delete" in contacts
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT deployment_id FROM onyx_native_runtime_document_links").fetchall() == [("foreign-deployment",)]
    assert "SYNTHETIC" not in (output / "knowledge-reconcile-checkpoint.json").read_text()
