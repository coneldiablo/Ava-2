import importlib.util
import json
from pathlib import Path
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("onyx_live_storage", ROOT / "scripts/verify-onyx-live-storage.py")
storage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage)


def deployment(business):
    deployment_id = str(uuid.uuid4())
    return {"businessId": business, "deploymentId": deployment_id,
            "nativeScope": "ava_" + deployment_id.replace("-", ""), "revision": 1}


def test_fixed_manifests_require_exact_scopes_and_qa_contract():
    live = deployment(1)
    operator = {"schemaVersion": 1, "kind": "ava_onyx_customer_entry_operator", **live,
                "principal": {"userId": str(uuid.uuid4()), "subject": "operator", "role": "manager"}}
    assert storage.live_scope(operator) == live
    bad = dict(operator); bad["nativeScope"] = "ava_" + "a" * 32
    with pytest.raises(storage.VerificationError):
        storage.live_scope(bad)
    qa = deployment(911002)
    manifest = {"qa_only": True, "buyer_acceptance": False, "rag_acceptance": False,
                "row": {"id": qa["deploymentId"], "businessId": qa["businessId"], "namespace": qa["nativeScope"],
                        "revision": qa["revision"], "module": "onyx", "sourceCommit": storage.PINNED_ONYX_SOURCE}, "payload": {}}
    assert storage.qa_scope(manifest) == qa
    manifest["row"]["businessId"] = 1
    with pytest.raises(storage.VerificationError):
        storage.qa_scope(manifest)
    image = "registry.invalid/onyx@sha256:" + "a" * 64
    assert storage.backend_image({"backendImage": image}) == image
    with pytest.raises(storage.VerificationError):
        storage.backend_image({"backendImage": "registry.invalid/onyx:latest"})


def test_probe_receipt_rejects_partial_or_cross_scope_result(monkeypatch):
    own, foreign = deployment(1), deployment(911002)
    valid = {"schema_version": 1, "scope": own, "checks": {key: True for key in storage.PROBE_CHECKS}}
    monkeypatch.setattr(storage, "_run", lambda *args, **kwargs: json.dumps(valid))
    assert storage.probe("a" * 64, own, foreign) == valid
    for value in ({"schema_version": 1, "scope": own, "checks": {}},
                  {**valid, "scope": foreign}, {**valid, "cookie": "never"}):
        monkeypatch.setattr(storage, "_run", lambda *args, value=value, **kwargs: json.dumps(value))
        with pytest.raises(storage.VerificationError):
            storage.probe("a" * 64, own, foreign)


def test_probe_source_has_no_secrets_or_arbitrary_scope_transport():
    own, foreign = deployment(1), deployment(911002)
    source = storage.probe_source(own, foreign)
    assert "S3_AWS_SECRET_ACCESS_KEY" in source
    assert "print(json.dumps" in source
    assert "nativeCookie" not in source
    assert "OPENSEARCH_ADMIN_PASSWORD" not in source[source.index("print(json.dumps"):]
    verifier_source = (ROOT / "scripts/verify-onyx-live-storage.py").read_text()
    assert "--operator-manifest" not in verifier_source
    assert "--directory" not in verifier_source
    assert '"docker", "exec", "-i"' in verifier_source
    assert "--privileged" not in verifier_source
    assert "--publish" not in verifier_source
    assert "SELECT index_name FROM search_settings" in source
    assert "default_transaction_read_only=on" in source
    assert "validate_index_name(row[0])" in source
    assert "bucket_global_list_scoped" in source


def test_receipt_labels_per_contour_acl_and_not_cross_server_reachability():
    live, qa = deployment(1), deployment(911002)
    container = {"id": "a" * 64, "image_id": "sha256:" + "b" * 64}
    result = storage.receipt(live, qa, container, container,
                             {"checks": {key: True for key in storage.PROBE_CHECKS}},
                             {"checks": {key: True for key in storage.PROBE_CHECKS}})
    assert set(result["checks"]) == {"live_container_binding", "qa_container_binding", "live_runtime_acl", "qa_runtime_acl"}
    assert "not_cross_server" in result["limitation"]
    assert "live_to_qa" not in result["checks"]


def test_api_container_requires_pinned_image_and_exact_docker_labels(monkeypatch):
    own = deployment(1)
    api_id = "a" * 64
    def item(container_id, service):
        return {"id": container_id, "image_id": "sha256:" + "c" * 64,
                "image": "example.invalid/onyx@sha256:" + "c" * 64,
                "deployment": own["deploymentId"], "business": "1", "revision": "1",
                "project": own["nativeScope"], "service": service, "running": True, "health": "healthy"}
    expected_image = "example.invalid/onyx@sha256:" + "c" * 64
    values = [api_id + "\n", json.dumps(item(api_id, "api"))]
    monkeypatch.setattr(storage, "_run", lambda *args, **kwargs: values.pop(0))
    assert storage.api_container(own, expected_image) == {"id": api_id, "image_id": "sha256:" + "c" * 64}
    bad = item(api_id, "api"); bad["project"] = "ava_" + "0" * 32
    values[:] = [api_id + "\n", json.dumps(bad)]
    with pytest.raises(storage.VerificationError):
        storage.api_container(own, expected_image)


def test_command_requires_explicit_run():
    with pytest.raises(SystemExit):
        storage.parse_args([])
    assert storage.parse_args(["--run"]).run is True
