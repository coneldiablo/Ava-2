#!/usr/bin/env python3
"""Generic periodic source catch-up through one private recipe container.

Default dry-run reads no credentials and contacts no container. --run bridges
only the fixed KnowledgeAPI operations through docker exec, then projects an
exact current checkpoint. Empty source sets reconcile deletions normally.
This job neither admits a runtime nor claims searchable/customer readiness.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import uuid
import time
import subprocess

from module_deployment_helper import private_json, DeploymentError
from onyx_native_verifier import container_for, require
import importlib.util


def load_bootstrap():
    spec = importlib.util.spec_from_file_location("ava_periodic_bootstrap", Path(__file__).with_name("bootstrap-onyx-native-knowledge.py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


bootstrap = load_bootstrap()
sync, projection = bootstrap.sync, bootstrap.projection


def catch_up(*, recipes, deployment_id, crm_db, run=False):
    require(str(uuid.UUID(deployment_id)) == deployment_id)
    root = recipes / deployment_id
    config_path = root / "config/knowledge-reconcile.json"
    checkpoint_path = root / "config/knowledge-reconcile-checkpoint.json"
    receipt_path = root / "config/knowledge-bootstrap-receipt.json"
    _, _root_config = private_json(config_path)
    config = sync.load_config(config_path)
    require(config["deploymentId"] == deployment_id)
    owner = bootstrap.owner_from_crm(crm_db, config)
    binding = bootstrap.current_binding(crm_db, config)
    _, recipe = private_json(root / "recipe.json"); _, compose = private_json(root / "compose.json")
    require(recipe["businessId"] == config["businessId"] and recipe["deploymentId"] == deployment_id
            and recipe["revision"] == config["revision"] and recipe["namespace"] == config["nativeScope"]
            and "knowledge-api" in compose["services"])
    common = {"config_path": config_path, "crm_db": crm_db, "checkpoint_path": checkpoint_path}
    if not run:
        return sync.plan(**common)
    scope = {key: config[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")}
    knowledge = container_for(scope, "knowledge-api", compose["services"]["knowledge-api"]["image"])
    def bridge(_url, _key, path, payload):
        require(path in ("/v1/knowledge/upsert", "/v1/knowledge/delete")
                and all(payload.get(key) == value for key, value in scope.items()))
        return bootstrap.execute(knowledge, bootstrap.KNOWLEDGE_REQUEST, {"path": path, "body": payload}, timeout=180)
    old_request = sync._request
    try:
        sync._request = bridge
        result = sync.reconcile(**common, api_url="http://knowledge-api",
                                worker_key_path=root / "config/knowledge-reconcile.key")
    finally:
        sync._request = old_request
    operator, receipt, checkpoint = projection.load_projection_inputs(config_path, receipt_path, checkpoint_path)
    api = container_for(scope, "api", compose["services"]["api"]["image"])
    documents = [{"source_id": item["source_id"], "native_id": projection.quote(key, safe=""), "content_hash": item["content_hash"]}
                 for key, item in checkpoint["documents"].items()]
    native_id = str(uuid.uuid5(uuid.UUID(deployment_id), "ava-user:" + config["runtimeUserId"]))
    index = bootstrap.validate_index_readback(bootstrap.execute(api, bootstrap.INDEX_RETRIEVAL, {
        "scope": scope, "runtime": {"nativeUserId": native_id}, "binding": receipt["binding"], "documents": documents}, timeout=180),
        documents, config["businessId"])
    index_proof = {"scope": scope, "checkedAt": int(time.time() * 1000), **index}
    require(operator == config and bootstrap.owner_from_crm(crm_db, config) == owner
            and bootstrap.current_binding(crm_db, config) == binding)
    sync.write_checkpoint(root / "config/knowledge-index-readback.json", index_proof)
    with sqlite3.connect(crm_db.resolve().as_uri() + "?mode=rw", uri=True, isolation_level=None) as db:
        count = projection.project(db, operator, receipt, checkpoint, index_readback=index_proof)
    return {"businessId": config["businessId"], **result, "projected": count,
            "dryRun": False, "runtimeAdmitted": False, "indexReadinessVerified": True, "searchabilityVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    require(os.geteuid() == 0)
    print(json.dumps(catch_up(recipes=Path(os.environ["AVA_ONYX_RECIPES_DIRECTORY"]),
        deployment_id=os.environ["AVA_ONYX_DEPLOYMENT_ID"], crm_db=Path(os.environ["AVA_CRM_DB_PATH"]), run=args.run), sort_keys=True))


if __name__ == "__main__":
    try: main()
    except (DeploymentError, sync.ReconcileError, projection.ProjectionError, KeyError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        raise SystemExit("ONYX_NATIVE_PERIODIC_SYNC_FAILED") from None
