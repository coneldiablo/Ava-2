import importlib.util
import json
from pathlib import Path
import stat
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("onyx_customer_entry_verifier", ROOT / "scripts/verify-onyx-customer-entry.py")
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def scope():
    return {"businessId": 911001, "deploymentId": str(uuid.uuid4()),
            "nativeScope": "ava_" + "a" * 32, "revision": 1}


def manifest(value):
    return {"schemaVersion": 1, "kind": "ava_onyx_customer_entry_operator", **value,
            "principal": {"userId": str(uuid.uuid4()), "subject": "operator-subject", "role": "manager"}}


def write_manifest(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def test_operator_manifest_requires_exact_runtime_scope_and_fixed_principal(tmp_path):
    current = scope()
    path = tmp_path / "operator.json"
    write_manifest(path, manifest(current))
    assert verifier.read_operator_manifest(path, current)["businessId"] == current["businessId"]
    for field, bad in (("businessId", 911002), ("deploymentId", str(uuid.uuid4())),
                       ("nativeScope", "ava_" + "b" * 32), ("revision", 2)):
        candidate = manifest(current)
        candidate[field] = bad
        write_manifest(path, candidate)
        with pytest.raises(verifier.VerificationError):
            verifier.read_operator_manifest(path, current)
    candidate = manifest(current)
    candidate["principal"] = {"userId": str(uuid.uuid4()), "subject": "browser supplied", "role": "admin"}
    write_manifest(path, candidate)
    with pytest.raises(verifier.VerificationError):
        verifier.read_operator_manifest(path, current)


def test_manifest_and_peer_files_must_not_be_writable_by_group_or_world(tmp_path, monkeypatch):
    current = scope()
    manifest_path = tmp_path / "operator.json"
    write_manifest(manifest_path, manifest(current))
    manifest_path.chmod(0o622)
    with pytest.raises(verifier.VerificationError):
        verifier.read_operator_manifest(manifest_path, current)
    key = tmp_path / "gateway.key"
    key.write_text("a" * 43)
    key.chmod(0o644)
    monkeypatch.setenv("AVA_AUTH_GATEWAY_KEY_FILE", str(key))
    with pytest.raises(verifier.VerificationError):
        verifier._read_peer_secret("AVA_AUTH_GATEWAY_KEY_FILE")


def test_partial_or_secret_bearing_receipts_are_not_accepted(monkeypatch):
    current = scope()
    user = {**current, "userId": str(uuid.uuid4()), "subject": "operator-subject", "role": "manager"}
    expected_provision = {**user, "nativeUserId": str(uuid.uuid4()), "state": "active"}
    assert verifier._exact(expected_provision, verifier.PROVISION_KEYS) == expected_provision
    for receipt in ({key: value for key, value in expected_provision.items() if key != "state"},
                    {**expected_provision, "cookie": "never"}):
        with pytest.raises(verifier.VerificationError):
            verifier._exact(receipt, verifier.PROVISION_KEYS)
    session = {"businessId": current["businessId"], "deploymentId": current["deploymentId"],
               "bindingId": str(uuid.uuid4()), "userId": user["userId"],
               "nativeUserId": expected_provision["nativeUserId"], "nativeScope": current["nativeScope"],
               "nativeCookie": "session=secret", "nativeSessionId": "a" * 64}
    assert verifier._exact(session, verifier.SESSION_KEYS) == session
    with pytest.raises(verifier.VerificationError):
        verifier._exact({key: value for key, value in session.items() if key != "nativeSessionId"}, verifier.SESSION_KEYS)
    receipt = {"schema_version": 1, "ok": True, "business_id": current["businessId"],
               "deployment_id": current["deploymentId"], "namespace": current["nativeScope"],
               "revision": current["revision"], "operator_user_id": user["userId"],
               "checks": {key: True for key in verifier.CHECKS}, "browser_storage_verified": False,
               "limitation": "no_browser_or_storage_proof"}
    assert verifier.validate_receipt(receipt, current, user["userId"]) == receipt
    for bad in ({key: value for key, value in receipt.items() if key != "checks"},
                {**receipt, "nativeCookie": "never"},
                {**receipt, "namespace": "ava_" + "b" * 32},
                {**receipt, "checks": {**receipt["checks"], "extra": True}}):
        with pytest.raises(verifier.VerificationError):
            verifier.validate_receipt(bad, current, user["userId"])


def test_command_is_explicit_and_source_never_emits_secret_material():
    with pytest.raises(SystemExit):
        verifier.parse_args(["--operator-manifest", "/run/ava/operator.json"])
    args = verifier.parse_args(["--run", "--operator-manifest", "/run/ava/operator.json"])
    assert args.run is True
    source = (ROOT / "scripts/verify-onyx-customer-entry.py").read_text()
    assert "http://127.0.0.1:4011" in source
    assert "http://api:8080" in source
    assert "ProxyHandler({})" in source
    assert "--publish" not in source
    assert "--privileged" not in source
    rendered = verifier.run.__doc__ or ""
    assert "" == rendered
    # The only stdout path serializes the safe, bounded receipt.  The cookie
    # is needed only for in-process requests and is never a receipt field.
    receipt_boundary = source[source.index("def validate_receipt"):source.index("def run")]
    assert '"nativeCookie"' not in receipt_boundary
