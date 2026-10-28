"""Fixed AVA-owned Onyx Community recipe factory.

This module deliberately renders a small, complete retrieval contour from a
root-owned digest catalogue.  It never accepts Compose, images, host paths or
network settings from a deployment request.  Model downloads are not a hidden
bootstrap action: the catalogue must attest that the model image already
contain the required cache, otherwise preparation fails closed.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import sys

from module_deployment_helper import (DIGEST, PINNED, UUID, DeploymentError,
                                      owned_path, private_json, validate_compose)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_modules.onyx import dependency_bootstrap, search_config


def fail(code: str) -> None:
    raise DeploymentError(code)


def encoded(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def identity(row: dict) -> dict:
    if row.get("module") != "onyx" or not UUID.fullmatch(row.get("id", "")):
        fail("DEPLOYMENT_FACTORY_UNSUPPORTED")
    if type(row.get("businessId")) is not int or row["businessId"] < 1 or type(row.get("revision")) is not int or row["revision"] < 1:
        fail("DEPLOYMENT_RECIPE_SCOPE_MISMATCH")
    compact = row["id"].replace("-", "")
    if row.get("namespace") != "ava_" + compact or row.get("sourceCommit") != PINNED["onyx"]:
        fail("DEPLOYMENT_RECIPE_SCOPE_MISMATCH")
    hostname = row.get("hostname", "")
    if (not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.knowledge\.meludtech\.tech", hostname)
            or not hostname.split(".", 1)[0].endswith("-" + str(row["businessId"]))):
        fail("DEPLOYMENT_RECIPE_SCOPE_MISMATCH")
    return {"deploymentId": row["id"], **{key: row[key] for key in ("businessId", "module", "revision", "hostname", "namespace", "sourceCommit")}}


IMAGE_KEYS = ("backendImage", "webImage", "modelImage", "postgresImage", "redisImage", "searchImage", "blobImage", "blobClientImage", "gatewayImage")
UID_KEYS = ("backendUid", "backendGid", "webUid", "webGid", "modelUid", "modelGid", "postgresUid", "postgresGid", "redisUid", "redisGid", "searchUid", "searchGid", "blobUid", "blobGid")
SECRET_NAMES = ("dbAdmin", "dbApp", "dbReadonly", "redis", "searchRuntime", "blobRootAccess", "blobRootSecret", "blobRuntimeSecret", "authSecret", "gatewayPeer", "workerPeer", "stateKey", "brokerPeer", "gatewayEncryption")
KNOWLEDGE_OVERLAY_FILES = ("auth/knowledge.py", "auth/knowledge_api.py", "auth/knowledge_app.py", "auth/knowledge_bootstrap.py",
                           "install_knowledge_acl.py", "install_ingestion_search.py")

INIT_ONYX_DB = """import os
import psycopg2

namespace = os.environ["AVA_DEPLOYMENT_NAMESPACE"]
conn = psycopg2.connect(
    host=os.environ["POSTGRES_HOST"],
    port=os.environ["POSTGRES_PORT"],
    dbname=os.environ["POSTGRES_DB"],
    user=os.environ["POSTGRES_USER"],
    password=os.environ["POSTGRES_PASSWORD"],
)
cur = conn.cursor()
cur.execute(
    "UPDATE search_settings SET index_name = replace(index_name, 'danswer_chunk', %s)",
    (namespace + "_documents",),
)
conn.commit()
cur.close()
conn.close()
"""

SUPERVISORD_CONF = """[supervisord]
nodaemon=true
logfile=/var/log/onyx/supervisord.log
pidfile=/tmp/supervisord.pid
environment=PYTHONPATH="/app"

[supervisorctl]
serverurl=unix:///tmp/supervisor.sock

[unix_http_server]
file=/tmp/supervisor.sock
chmod=0700

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[program:celery_worker_primary]
command=celery -A onyx.background.celery.versioned_apps.primary worker
    --hostname=primary@%%n
    -Q celery
stdout_logfile=/var/log/onyx/celery_worker_primary.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_light]
command=celery -A onyx.background.celery.versioned_apps.light worker
    --hostname=light@%%n
    -Q vespa_metadata_sync,connector_deletion,doc_permissions_upsert,checkpoint_cleanup,index_attempt_cleanup,opensearch_migration,chat_ttl_deletion
stdout_logfile=/var/log/onyx/celery_worker_light.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_heavy]
command=celery -A onyx.background.celery.versioned_apps.heavy worker
    --hostname=heavy@%%n
    -Q connector_pruning,connector_doc_permissions_sync,connector_external_group_sync,csv_generation,sandbox,connector_hierarchy_fetching
stdout_logfile=/var/log/onyx/celery_worker_heavy.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_docprocessing]
command=celery -A onyx.background.celery.versioned_apps.docprocessing worker
    --hostname=docprocessing@%%n
    -Q docprocessing,port
stdout_logfile=/var/log/onyx/celery_worker_docprocessing.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_user_file_processing]
command=celery -A onyx.background.celery.versioned_apps.user_file_processing worker
    --hostname=user_file_processing@%%n
    -Q user_file_processing,user_file_project_sync,user_file_delete,user_file_port
stdout_logfile=/var/log/onyx/celery_worker_user_file_processing.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_scheduled_tasks]
command=celery -A onyx.background.celery.versioned_apps.scheduled_tasks worker
    --hostname=scheduled_tasks@%%n
    -Q scheduled_tasks
stdout_logfile=/var/log/onyx/celery_worker_scheduled_tasks.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_docfetching]
command=celery -A onyx.background.celery.versioned_apps.docfetching worker
    --hostname=docfetching@%%n
    -Q connector_doc_fetching
stdout_logfile=/var/log/onyx/celery_worker_docfetching.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_worker_monitoring]
command=celery -A onyx.background.celery.versioned_apps.monitoring worker
    --hostname=monitoring@%%n
    -Q monitoring
stdout_logfile=/var/log/onyx/celery_worker_monitoring.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startsecs=10
stopasgroup=true

[program:celery_beat]
command=celery -A onyx.background.celery.versioned_apps.beat beat -s /tmp/celerybeat-schedule
stdout_logfile=/var/log/onyx/celery_beat.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
startsecs=10
stopasgroup=true

[program:supervisord_watchdog_celery_beat]
command=python -m onyx.utils.supervisord_watchdog
    --conf /run/ava/supervisord.conf
    --key "onyx:celery:beat:heartbeat"
    --program celery_beat
stdout_logfile=/var/log/onyx/supervisord_watchdog_celery_beat.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
startsecs=10
stopasgroup=true

[program:slack_bot]
command=python onyx/onyxbot/slack/listener.py
stdout_logfile=/var/log/onyx/slack_bot.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startretries=5
startsecs=60

[program:discord_bot]
command=python onyx/onyxbot/discord/client.py
stdout_logfile=/var/log/onyx/discord_bot.log
stdout_logfile_maxbytes=16MB
redirect_stderr=true
autorestart=true
startretries=5
startsecs=60

[program:log-redirect-handler]
command=tail -qF
    /var/log/onyx/celery_beat.log
    /var/log/onyx/celery_worker_primary.log
    /var/log/onyx/celery_worker_light.log
    /var/log/onyx/celery_worker_heavy.log
    /var/log/onyx/celery_worker_docprocessing.log
    /var/log/onyx/celery_worker_monitoring.log
    /var/log/onyx/celery_worker_user_file_processing.log
    /var/log/onyx/celery_worker_scheduled_tasks.log
    /var/log/onyx/celery_worker_docfetching.log
    /var/log/onyx/slack_bot.log
    /var/log/onyx/discord_bot.log
    /var/log/onyx/supervisord_watchdog_celery_beat.log
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
autorestart=true
"""


def catalogue(value: object) -> dict:
    required = {"schemaVersion", "sourceCommit", "modelCacheManifest", "namespaceOverlayManifest", *IMAGE_KEYS, *UID_KEYS}
    if not isinstance(value, dict) or set(value) not in (required, required | {"knowledgeOverlayManifest"}) or value["schemaVersion"] != 1 or value["sourceCommit"] != PINNED["onyx"]:
        fail("DEPLOYMENT_IMAGE_CATALOGUE_INVALID")
    for key in IMAGE_KEYS:
        if (not isinstance(value[key], str)
                or not re.fullmatch(r"(?:[A-Za-z0-9._:/-]+@)?sha256:[0-9a-f]{64}", value[key])):
            fail("DEPLOYMENT_IMAGE_CATALOGUE_INVALID")
    for key in UID_KEYS:
        if type(value[key]) is not int or not 1 <= value[key] <= 65535:
            fail("DEPLOYMENT_IMAGE_CATALOGUE_INVALID")
    expected_upstream_ids = {"backendUid": 1001, "backendGid": 1001, "modelUid": 1001, "modelGid": 1001,
                             "webUid": 1000, "webGid": 1000}
    if any(value[key] != expected for key, expected in expected_upstream_ids.items()):
        fail("DEPLOYMENT_IMAGE_CATALOGUE_INVALID")
    overlay = value["namespaceOverlayManifest"]
    overlay_files = {
        "ava_namespace.py": Path(__file__).resolve().parents[1] / "native_modules/onyx/ava_namespace.py",
        "install_namespace.py": Path(__file__).resolve().parents[1] / "native_modules/onyx/install_namespace.py",
    }
    expected_overlay_hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in overlay_files.items()}
    if (not isinstance(overlay, dict)
            or set(overlay) != {"schemaVersion", "sourceCommit", "backendImageDigest", "files"}
            or overlay["schemaVersion"] != 1 or overlay["sourceCommit"] != PINNED["onyx"]
            or overlay["backendImageDigest"] != value["backendImage"].split("@")[-1]
            or overlay["files"] != expected_overlay_hashes):
        fail("DEPLOYMENT_NAMESPACE_OVERLAY_REQUIRED")
    if "knowledgeOverlayManifest" in value:
        knowledge = value["knowledgeOverlayManifest"]
        expected = {name: hashlib.sha256((Path(__file__).resolve().parents[1] / "native_modules/onyx" / name).read_bytes()).hexdigest()
                    for name in KNOWLEDGE_OVERLAY_FILES}
        if (not isinstance(knowledge, dict)
                or set(knowledge) != {"schemaVersion", "sourceCommit", "backendImageDigest", "files"}
                or type(knowledge["schemaVersion"]) is not int or knowledge["schemaVersion"] != 1
                or knowledge["sourceCommit"] != PINNED["onyx"]
                or knowledge["backendImageDigest"] != value["backendImage"].split("@")[-1]
                or knowledge["files"] != expected):
            fail("DEPLOYMENT_KNOWLEDGE_OVERLAY_REQUIRED")
    manifest = value["modelCacheManifest"]
    if (not isinstance(manifest, dict)
            or set(manifest) != {"schemaVersion", "sourceCommit", "modelImageDigest", "cacheRoot", "files"}
            or manifest["schemaVersion"] != 1
            or manifest["sourceCommit"] != PINNED["onyx"]
            or manifest["modelImageDigest"] != value["modelImage"].split("@")[-1]
            or manifest["cacheRoot"] != "/app/.cache/temp_huggingface/hub"
            or not isinstance(manifest["files"], list) or not manifest["files"]):
        fail("DEPLOYMENT_MODEL_CACHE_REQUIRED")
    paths, kinds = set(), set()
    for artifact in manifest["files"]:
        if (not isinstance(artifact, dict) or set(artifact) != {"path", "sha256", "size"}
                or not isinstance(artifact["path"], str)
                or not re.fullmatch(r"models--[A-Za-z0-9_.-]+--[A-Za-z0-9_.-]+/(?:blobs/[0-9a-f]+|refs/[A-Za-z0-9_./-]+|snapshots/[0-9a-f]{40}/[A-Za-z0-9_./-]+)", artifact["path"])
                or ".." in Path(artifact["path"]).parts or artifact["path"] in paths
                or not isinstance(artifact["sha256"], str) or not DIGEST.fullmatch("sha256:" + artifact["sha256"])
                or type(artifact["size"]) is not int or artifact["size"] < 1):
            fail("DEPLOYMENT_MODEL_CACHE_REQUIRED")
        paths.add(artifact["path"])
        kinds.add(artifact["path"].split("/", 2)[1])
    if kinds != {"blobs", "refs", "snapshots"}:
        fail("DEPLOYMENT_MODEL_CACHE_REQUIRED")
    return value


def _secrets(keys: object) -> dict:
    if not isinstance(keys, dict) or set(keys) != set(SECRET_NAMES):
        fail("DEPLOYMENT_GENERATED_SECRETS_INVALID")
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}" if name == 'stateKey' else r"[A-Za-z0-9_-]{43}", value) for name, value in keys.items()) or len(set(keys.values())) != len(keys):
        fail("DEPLOYMENT_GENERATED_SECRETS_INVALID")
    return keys


def render(row: dict, images: object, keys: object, root: str | Path, search_claims: object):
    """Return private files, Compose JSON and public recipe deterministically."""
    scope, images, keys, root = identity(row), catalogue(images), _secrets(keys), Path(root)
    memory_mib = 13824 if "knowledgeOverlayManifest" in images else 12800
    if type(row.get("reservedMemoryMiB")) is not int or row["reservedMemoryMiB"] < memory_mib:
        fail("DEPLOYMENT_RESERVATION_TOO_SMALL")
    namespace = scope["namespace"]
    if (not isinstance(search_claims, dict) or search_claims.get("schemaVersion") != 1
            or search_claims.get("namespace") != namespace or not isinstance(search_claims.get("files"), dict)
            or set(search_claims["files"]) != {*search_config.TLS_FILES, *search_config._config_files(namespace).keys()}
            or any(not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
                   for digest in search_claims["files"].values())):
        fail("DEPENDENCY_TLS_MATERIAL_REQUIRED")
    bucket = namespace.replace("_", "-") + "-files"
    runtime_search_user = namespace + "_runtime"
    runtime_object_user = dependency_bootstrap.runtime_object_user(namespace)
    labels = {"tech.melud.ava.deployment": row["id"], "tech.melud.ava.business": str(row["businessId"]), "tech.melud.ava.revision": str(row["revision"])}
    dependency_claims = {
        "schemaVersion": 1, "deploymentId": row["id"], "namespace": namespace,
        "sourceCommit": row["sourceCommit"], "bucket": bucket,
        "minioPolicy": namespace.replace("_", "-") + "-runtime", "minioUser": runtime_object_user,
        "opensearchRole": runtime_search_user, "opensearchUser": runtime_search_user,
        "indexPatterns": [namespace + "_documents", namespace + "_documents_*"],
        "searchImageDigest": images["searchImage"].split("@")[-1],
        "searchCaSha256": search_claims["files"]["ca.pem"],
        "blobImageDigest": images["blobImage"].split("@")[-1],
        "namespaceOverlayManifestSha256": hashlib.sha256(encoded(images["namespaceOverlayManifest"])).hexdigest(),
        "dependencyBootstrapSha256": hashlib.sha256(Path(dependency_bootstrap.__file__).read_bytes()).hexdigest(),
    }

    # The user-facing processes receive only the per-contour DB role; database,
    # search and blob administration remains in root-only config files.
    native_env = {
        "AVA_DEPLOYMENT_NAMESPACE": namespace, "AVA_BUSINESS_ID": str(row["businessId"]), "AVA_DEPLOYMENT_ID": row["id"], "AVA_DEPLOYMENT_REVISION": str(row["revision"]),
        "POSTGRES_HOST": "database", "POSTGRES_PORT": "5432", "POSTGRES_DB": namespace, "POSTGRES_USER": namespace,
        "POSTGRES_PASSWORD": keys["dbApp"], "DB_READONLY_USER": namespace + "_ro", "DB_READONLY_PASSWORD": keys["dbReadonly"],
        "REDIS_HOST": "cache", "REDIS_PORT": "6379", "REDIS_PASSWORD": keys["redis"],
        "AUTH_TYPE": "basic", "AUTH_BACKEND": "redis", "MULTI_TENANT": "false", "FILE_STORE_BACKEND": "s3",
        "S3_ENDPOINT_URL": "http://blob:9000", "S3_FILE_STORE_BUCKET_NAME": bucket,
        "S3_AWS_ACCESS_KEY_ID": runtime_object_user, "S3_AWS_SECRET_ACCESS_KEY": keys["blobRuntimeSecret"],
        "OPENSEARCH_HOST": "search", "OPENSEARCH_ADMIN_USERNAME": runtime_search_user, "OPENSEARCH_ADMIN_PASSWORD": keys["searchRuntime"], "OPENSEARCH_USE_SSL": "true", "OPENSEARCH_VERIFY_CERTS": "true", "OPENSEARCH_CA_CERTS": "/run/ava-search-ca/ca.pem",
        "MODEL_SERVER_HOST": "inference_model", "INDEXING_MODEL_SERVER_HOST": "indexing_model",
        "USER_AUTH_SECRET": keys["authSecret"], "SESSION_EXPIRE_TIME_SECONDS": "3600",
        "DISABLE_TELEMETRY": "true", "ENABLE_PAID_ENTERPRISE_EDITION_FEATURES": "false", "LOG_LEVEL": "error",
    }
    # Importing the Community auth/database strategies needs the contour DB,
    # Redis auth backend and FastAPI Users secret.  Keep the private listener
    # off the API/worker environment so it cannot inherit search, blob, model
    # or read-only reporting credentials it neither uses nor mounts.
    auth_env = {key: native_env[key] for key in (
        "AVA_DEPLOYMENT_NAMESPACE", "AVA_BUSINESS_ID", "AVA_DEPLOYMENT_ID", "AVA_DEPLOYMENT_REVISION",
        "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD",
        "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD", "AUTH_TYPE", "AUTH_BACKEND", "MULTI_TENANT",
        "USER_AUTH_SECRET", "SESSION_EXPIRE_TIME_SECONDS",
        "DISABLE_TELEMETRY", "ENABLE_PAID_ENTERPRISE_EDITION_FEATURES", "LOG_LEVEL",
        # Imported by the namespace guard even in an auth-only process. This
        # is an ownership identifier, not a credential or storage connection.
        "S3_FILE_STORE_BUCKET_NAME",
    )}
    admin = "admin_" + row["id"].replace("-", "")
    sql = (f"CREATE ROLE {namespace} LOGIN PASSWORD '{keys['dbApp']}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
           f"CREATE ROLE {namespace}_ro LOGIN PASSWORD '{keys['dbReadonly']}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
           f"ALTER DATABASE {namespace} OWNER TO {namespace};\n"
           "REVOKE ALL ON DATABASE postgres FROM PUBLIC;\n"
           f"REVOKE ALL ON DATABASE {namespace} FROM PUBLIC;\n"
           f"GRANT CONNECT ON DATABASE {namespace} TO {namespace}_ro;\n"
           "CREATE EXTENSION IF NOT EXISTS pgcrypto;\n"
           "CREATE EXTENSION IF NOT EXISTS pg_trgm;\n")
    files = {
        "native.env": ("\n".join(f"{key}={value}" for key, value in native_env.items()) + "\n", 0o600, images["backendGid"]),
        "auth.env": ("\n".join(f"{key}={value}" for key, value in auth_env.items()) + "\n", 0o600, images["backendGid"]),
        "database.env": (f"POSTGRES_USER={admin}\nPOSTGRES_PASSWORD={keys['dbAdmin']}\nPOSTGRES_DB={namespace}\n", 0o600, images["postgresGid"]),
        "seed.sql": (sql, 0o640, images["postgresGid"]),
        "redis.conf": (f"bind 0.0.0.0\nprotected-mode yes\nappendonly yes\nrequirepass {keys['redis']}\n", 0o640, images["redisGid"]),
        "search.env": ("DISABLE_INSTALL_DEMO_CONFIG=true\n", 0o600, images["searchGid"]),
        "blob.env": (f"MINIO_ROOT_USER={keys['blobRootAccess']}\nMINIO_ROOT_PASSWORD={keys['blobRootSecret']}\n", 0o600, images["blobGid"]),
        "opensearch-bootstrap.env": (f"AVA_DEPLOYMENT_NAMESPACE={namespace}\n", 0o600, 0),
        "opensearch-runtime-password": (keys["searchRuntime"] + "\n", 0o400, 0),
        "dependency-claims.json": (json.dumps(dependency_claims, sort_keys=True, separators=(",", ":")) + "\n", 0o400, 0),
        "mc-config.json": (json.dumps({"version": "10", "aliases": {
            "admin": {"url": "http://blob:9000", "accessKey": keys["blobRootAccess"], "secretKey": keys["blobRootSecret"], "api": "S3v4", "path": "auto"},
            "runtime": {"url": "http://blob:9000", "accessKey": runtime_object_user, "secretKey": keys["blobRuntimeSecret"], "api": "S3v4", "path": "auto"},
        }}, sort_keys=True, separators=(",", ":")) + "\n", 0o600, 0),
        "minio-runtime-credentials": (runtime_object_user + "\n" + keys["blobRuntimeSecret"] + "\n", 0o600, 0),
        "minio-policy.json": (json.dumps(dependency_bootstrap.minio_policy(namespace), sort_keys=True, separators=(",", ":")) + "\n", 0o600, 0),
        "minio-bootstrap.sh": (dependency_bootstrap.minio_bootstrap_script(namespace), 0o500, 0),
        "dependency-bootstrap.py": (Path(dependency_bootstrap.__file__).read_text(encoding="utf-8"), 0o500, 0),
        "run-securityadmin.sh": ("#!/bin/bash\nset -eu\ni=0\nuntil /usr/share/opensearch/plugins/opensearch-security/tools/securityadmin.sh -h search -p 9200 -cd /run/ava/security -cacert /run/ava/tls/ca.pem -cert /run/ava/tls/admin.pem -key /run/ava/tls/admin-key.pem -icl -arc >/dev/null 2>&1; do\n  i=$((i + 1)); [ \"$i\" -lt 60 ] || exit 51; sleep 2\ndone\n", 0o440, images['searchGid']),
        # The native peer is duplicated into two immutable, UID-correct files:
        # backend readers are gid 1001 while the gateway is gid 1000.  Neither
        # service gains group access to the other's unrelated credentials.
        "gateway.key": (keys["gatewayPeer"], 0o440, images["backendGid"]),
        "native-peer.key": (keys["gatewayPeer"], 0o440, images["webGid"]),
        "worker.key": (keys["workerPeer"], 0o440, images["backendGid"]),
        "state.key": (keys["stateKey"], 0o440, images["backendGid"]),
        "broker-peer.key": (keys["brokerPeer"], 0o640, images["webGid"]),
        "gateway-encryption.key": (keys["gatewayEncryption"], 0o640, images["webGid"]),
        "init-onyx-db.py": (INIT_ONYX_DB, 0o440, images["backendGid"]),
        "supervisord.conf": (SUPERVISORD_CONF, 0o440, images["backendGid"]),
    }
    enrollment = {**scope, "schemaVersion": 1, "adapterId": row["id"], "nativeScope": namespace}
    gateway_config = {
        "businessId": row["businessId"], "module": "onyx", "deploymentId": row["id"],
        "revision": row["revision"], "adapterId": row["id"], "nativeScope": namespace,
        "publicOrigin": "https://" + row["hostname"], "avaOrigin": "https://wh.meludtech.tech",
        "brokerOrigin": "http://ava-module-access:3901", "nativeOrigin": "http://auth:4011",
        "upstreamOrigin": "http://web:3000",
    }
    files.update({
        "enrollment.json": (encoded(enrollment).decode(), 0o400, 0),
        "gateway.json": (encoded(gateway_config).decode(), 0o440, images["webGid"]),
    })
    def bind(name: str, target: str): return {"type": "bind", "source": str(root / "config" / name), "target": target, "read_only": True}
    def volume(name: str, target: str, readonly=False): return {"type": "volume", "source": name, "target": target, "read_only": readonly}
    def service(image: str, memory: int, uid: int, gid: int):
        return {"image": image, "user": f"{uid}:{gid}", "labels": dict(labels), "networks": ["native"], "read_only": True,
                "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "mem_limit": memory * 1024**2,
                "cpus": 2, "pids_limit": 512, "restart": "unless-stopped"}
    database = {**service(images["postgresImage"], 1792, images["postgresUid"], images["postgresGid"]), "env_file": [str(root / "config/database.env")],
                "volumes": [volume("database", "/var/lib/postgresql/data"), bind("seed.sql", "/docker-entrypoint-initdb.d/10-ava.sql")],
                "tmpfs": [f"/var/run/postgresql:rw,nosuid,nodev,uid={images['postgresUid']},gid={images['postgresGid']},size=8m",
                          "/tmp:rw,nosuid,nodev,size=64m"],
                "healthcheck": {"test": ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", admin, "-d", namespace], "interval": "5s", "timeout": "3s", "retries": 60}}
    cache = {**service(images["redisImage"], 256, images["redisUid"], images["redisGid"]), "command": ["redis-server", "/run/ava/redis.conf"], "volumes": [volume("cache", "/data"), bind("redis.conf", "/run/ava/redis.conf")]}
    search = {**service(images["searchImage"], 3072, images["searchUid"], images["searchGid"]), "env_file": [str(root / "config/search.env")],
              "environment": {"OPENSEARCH_TMPDIR": "/run/ava-jni"},
              # The stock image has no keystore; bootstrap creates one here.
              # Security config and TLS remain separate read-only bind mounts.
              "volumes": [volume("search", "/usr/share/opensearch/data"), volume("search_config", "/usr/share/opensearch/config"), bind("search-config/opensearch.yml", "/usr/share/opensearch/config/opensearch.yml"),
                          *[bind("search-config/" + name, "/usr/share/opensearch/config/ava-tls/" + name) for name in ("ca.pem", "node.pem", "node-key.pem")]],
              "tmpfs": ["/tmp:rw,nosuid,nodev,size=64m",
                        # The pinned JVM extracts Bouncy Castle native libraries.
                        # Keep ordinary /tmp noexec; only this private, bounded
                        # UID-owned mount permits loading native code.
                        f"/run/ava-jni:rw,nosuid,nodev,exec,uid={images['searchUid']},gid={images['searchGid']},mode=0700,size=64m",
                        f"/usr/share/opensearch/logs:rw,nosuid,nodev,uid={images['searchUid']},gid={images['searchGid']},mode=0750,size=128m"]}
    blob = {**service(images["blobImage"], 512, images["blobUid"], images["blobGid"]), "env_file": [str(root / "config/blob.env")], "command": ["server", "/data"], "volumes": [volume("blob", "/data")]}
    search_security_init = {**service(images["searchImage"], 256, images["searchUid"], images["searchGid"]), "restart": "no", "entrypoint": ["/bin/bash"], "command": ["/run/ava/run-securityadmin.sh"],
                            "environment": {"JAVA_OPTS": "-Xms64m -Xmx128m -Djava.io.tmpdir=/run/ava-jni"},
                            "volumes": [bind("run-securityadmin.sh", "/run/ava/run-securityadmin.sh"), bind("search-config/security", "/run/ava/security"),
                                        *[bind("search-config/" + name, "/run/ava/tls/" + name) for name in ("ca.pem", "admin.pem", "admin-key.pem")]],
                            "tmpfs": ["/tmp:rw,nosuid,nodev,size=32m", f"/run/ava-jni:rw,nosuid,nodev,exec,uid={images['searchUid']},gid={images['searchGid']},mode=0700,size=32m"], "depends_on": {"search": {"condition": "service_started"}}}
    search_bootstrap = {**service(images["backendImage"], 128, 0, 0),
                        "restart": "no", "command": ["python", "/run/ava/dependency-bootstrap.py", "opensearch"],
                        "environment": {"PYTHONDONTWRITEBYTECODE": "1"},
                        "env_file": [str(root / "config/opensearch-bootstrap.env")],
                        "volumes": [bind("dependency-bootstrap.py", "/run/ava/dependency-bootstrap.py"), bind("search-config/ca.pem", "/run/ava-search-ca/ca.pem"),
                                    bind("search-config/admin.pem", "/run/ava-search-ca/admin.pem"), bind("search-config/admin-key.pem", "/run/ava-search-ca/admin-key.pem"),
                                    bind("opensearch-runtime-password", "/run/ava-search-ca/runtime-password")],
                        "tmpfs": ["/tmp:rw,nosuid,nodev,size=16m"], "depends_on": {"search_security_init": {"condition": "service_completed_successfully"}}}
    blob_bootstrap = {**service(images["blobClientImage"], 128, 0, 0),
                      "restart": "no", "entrypoint": ["/bin/sh"], "command": ["/run/ava/minio-bootstrap.sh"],
                      "environment": {"MC_CONFIG_DIR": "/tmp/mc", "MC_NO_COLOR": "1"},
                      "volumes": [bind("minio-bootstrap.sh", "/run/ava/minio-bootstrap.sh"), bind("minio-policy.json", "/run/ava/minio-policy.json"), bind("mc-config.json", "/run/ava/mc-config.json"), bind("minio-runtime-credentials", "/run/ava/minio-runtime-credentials"), bind("dependency-claims.json", "/run/ava/dependency-claims.json")],
                      "tmpfs": ["/tmp:rw,nosuid,nodev,size=16m"], "depends_on": {"blob": {"condition": "service_started"}}}
    backend_dependencies = {"database": {"condition": "service_healthy"}, "cache": {"condition": "service_started"},
                            "search_bootstrap": {"condition": "service_completed_successfully"},
                            "blob_bootstrap": {"condition": "service_completed_successfully"}}
    def backend(command: list[str], memory: int):
        return {**service(images["backendImage"], memory, images["backendUid"], images["backendGid"]), "command": command,
                "env_file": [str(root / "config/native.env")],
                "volumes": [volume("logs", "/var/log/onyx"), bind("search-config/ca.pem", "/run/ava-search-ca/ca.pem")],
                "tmpfs": ["/tmp:rw,nosuid,nodev,size=128m"], "depends_on": dict(backend_dependencies)}
    api = backend(["/bin/sh", "-c", "alembic upgrade head && python /run/ava/init-onyx-db.py && uvicorn onyx.main:app --host 0.0.0.0 --port 8080"], 2048)
    api["environment"] = {
        "AVA_NATIVE_HTTP_GUARD": "true", "AVA_AUTH_STATE_FILE": "/var/lib/ava-auth/state.sqlite",
        "AVA_AUTH_ENCRYPTION_KEY_FILE": "/run/ava-keys/state.key",
        "AVA_NATIVE_HTTP_GATEWAY_KEY_FILE": "/run/ava-keys/gateway.key",
    }
    api["volumes"].extend([volume("auth_state", "/var/lib/ava-auth"),
                           bind("gateway.key", "/run/ava-keys/gateway.key"), bind("state.key", "/run/ava-keys/state.key"),
                           bind("init-onyx-db.py", "/run/ava/init-onyx-db.py")])
    api["depends_on"]["inference_model"] = {"condition": "service_healthy"}
    # Liveness only: Uvicorn has completed lifespan and installed the guard.
    # Dependency, embedding and real RAG acceptance are separate QA gates;
    # the native /health/ready endpoint requires a buyer session under guard.
    api["healthcheck"] = {"test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/ava-native-healthz')"], "interval": "10s", "timeout": "5s", "retries": 60}
    worker = backend(["/usr/bin/supervisord", "-c", "/run/ava/supervisord.conf"], 1536)
    worker["environment"] = {"AVA_NATIVE_HTTP_GUARD": "false"}
    worker["volumes"].append(bind("supervisord.conf", "/run/ava/supervisord.conf"))
    worker["depends_on"]["api"] = {"condition": "service_healthy"}
    worker["depends_on"]["inference_model"] = {"condition": "service_healthy"}
    worker["depends_on"]["indexing_model"] = {"condition": "service_healthy"}
    # The private web service proxies browser API requests to the guarded API.
    # Upstream disables this Next.js route in production unless explicitly enabled.
    web = {**service(images["webImage"], 512, images["webUid"], images["webGid"]), "environment": {"INTERNAL_URL": "http://api:8080", "OVERRIDE_API_PRODUCTION": "true"}, "depends_on": {"api": {"condition": "service_healthy"}}, "tmpfs": ["/tmp:rw,nosuid,nodev,size=64m"]}
    auth = {**service(images["backendImage"], 256, images["backendUid"], images["backendGid"]),
            "command": ["uvicorn", "onyx.ava_auth.app:app", "--host", "0.0.0.0", "--port", "4011", "--no-access-log"],
            "env_file": [str(root / "config/auth.env")],
            "environment": {"AVA_NATIVE_HTTP_GUARD": "false", "AVA_AUTH_STATE_FILE": "/var/lib/ava-auth/state.sqlite",
                            "AVA_AUTH_ENCRYPTION_KEY_FILE": "/run/ava-keys/state.key",
                            "AVA_AUTH_GATEWAY_KEY_FILE": "/run/ava-keys/gateway.key",
                            "AVA_AUTH_WORKER_KEY_FILE": "/run/ava-keys/worker.key"},
            "volumes": [volume("auth_state", "/var/lib/ava-auth"), bind("gateway.key", "/run/ava-keys/gateway.key"),
                        bind("worker.key", "/run/ava-keys/worker.key"), bind("state.key", "/run/ava-keys/state.key")],
            "tmpfs": ["/tmp:rw,nosuid,nodev,size=64m"], "depends_on": dict(backend_dependencies),
            # Probe a real signed-peer endpoint without mounting a credential
            # into the health command. A contained 403 proves the private app
            # completed lifespan; a connection error or other status fails.
            "healthcheck": {"test": ["CMD", "python", "-c", "import urllib.error,urllib.request;u='http://127.0.0.1:4011/v1/sessions/create';r=urllib.request.Request(u,data=b'{}',method='POST');\ntry: urllib.request.urlopen(r);raise SystemExit(1)\nexcept urllib.error.HTTPError as e: raise SystemExit(0 if e.code==403 else 1)"],
                            "interval": "5s", "timeout": "3s", "retries": 30, "start_period": "5s"}}
    gateway = {**service(images["gatewayImage"], 256, images["webUid"], images["webGid"]),
               "networks": ["native", "ingress", "access"],
               "volumes": [bind("gateway.json", "/run/ava/gateway.json"),
                           bind("broker-peer.key", "/run/ava/secrets/broker-peer"),
                           bind("gateway-encryption.key", "/run/ava/secrets/encryption-key"),
                           bind("native-peer.key", "/run/ava/secrets/native-peer"),
                           volume("gateway", "/var/lib/ava-gateway")],
               "tmpfs": ["/tmp:rw,nosuid,nodev,size=16m"],
               "depends_on": {"auth": {"condition": "service_healthy"}, "web": {"condition": "service_started"}},
               "healthcheck": {"test": ["CMD", "node", "-e", "const http=require('http'),c=require('/run/ava/gateway.json');const r=http.get({host:'127.0.0.1',port:4080,path:'/healthz',headers:{host:new URL(c.publicOrigin).host}},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1))});r.on('error',()=>process.exit(1));r.setTimeout(2000,()=>{r.destroy();process.exit(1)})"],
                               "interval": "5s", "timeout": "3s", "retries": 15, "start_period": "5s"}}
    def model(indexing: bool):
        prefix = "indexing" if indexing else "inference"
        result = {**service(images["modelImage"], 1024, images["modelUid"], images["modelGid"]), "command": ["python", "-m", "model_server"],
                  "environment": {"INDEXING_ONLY": "True" if indexing else "False", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
                  # Both volumes are Docker-seeded from the digest image. The
                  # pinned lifespan moves the immutable temp cache into the HF
                  # cache, so its source must also be writable under read_only.
                  "volumes": [volume(prefix + "_models", "/app/.cache/huggingface"),
                              volume(prefix + "_model_seed", "/app/.cache/temp_huggingface"),
                              volume("logs", "/var/log/onyx")],
                  "tmpfs": ["/tmp:rw,nosuid,nodev,size=64m"],
                  "healthcheck": {"test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/api/health')"], "interval": "20s", "timeout": "5s", "retries": 30, "start_period": "60s"}}
        return result
    compose = {"services": {"database": database, "cache": cache, "search": search, "blob": blob, "search_security_init": search_security_init, "search_bootstrap": search_bootstrap, "blob_bootstrap": blob_bootstrap, "inference_model": model(False), "indexing_model": model(True), "api": api, "worker": worker, "web": web, "auth": auth, "gateway": gateway},
               "networks": {"native": {"internal": True},
                            "ingress": {"external": True, "name": "ava-module-ingress"},
                            "access": {"external": True, "name": "ava-module-access"}},
               "volumes": {name: {} for name in ("database", "cache", "search", "search_config", "blob", "inference_models", "indexing_models", "inference_model_seed", "indexing_model_seed", "logs", "auth_state", "gateway")}}
    if "knowledgeOverlayManifest" in images:
        knowledge_api = backend(["uvicorn", "onyx.ava_auth.knowledge_app:app", "--host", "0.0.0.0", "--port", "4013", "--no-access-log"], 1024)
        knowledge_api["environment"] = {"AVA_NATIVE_HTTP_GUARD": "false", "AVA_AUTH_STATE_FILE": "/var/lib/ava-auth/state.sqlite",
                                        "AVA_AUTH_WORKER_KEY_FILE": "/run/ava-keys/worker.key"}
        # The writer secret has no mount into web/API/gateway. The auth state
        # fence is read-only, and no Docker socket or public port is exposed.
        knowledge_api["volumes"] = [volume("logs", "/var/log/onyx"), bind("search-config/ca.pem", "/run/ava-search-ca/ca.pem"),
                                    {**volume("auth_state", "/var/lib/ava-auth"), "read_only": True}, bind("worker.key", "/run/ava-keys/worker.key")]
        knowledge_api["depends_on"].update({"auth": {"condition": "service_healthy"}, "api": {"condition": "service_healthy"}})
        knowledge_api["healthcheck"] = {"test": ["CMD", "python", "-c", "import urllib.error,urllib.request\ntry: urllib.request.urlopen('http://127.0.0.1:4013/v1/knowledge/bootstrap',data=b'{}');raise SystemExit(1)\nexcept urllib.error.HTTPError as e: raise SystemExit(0 if e.code==403 else 1)"],
                                        "interval": "5s", "timeout": "3s", "retries": 30, "start_period": "10s"}
        compose["services"]["knowledge-api"] = knowledge_api
    # Keep the launch receipt on the helper's closed schema.  The stronger
    # catalogue/bootstrap attestations remain in the root-owned catalogue and
    # dependency claim file; adding unrecognised public receipt fields would
    # make the actual helper reject this otherwise valid recipe at launch.
    recipe = {**scope, "schemaVersion": 1, "memoryMiB": memory_mib,
              "imageDigest": images["backendImage"].split("@")[-1],
              "composeSha256": hashlib.sha256(encoded(compose)).hexdigest(),
              "initServices": ["search_security_init", "search_bootstrap", "blob_bootstrap"]}
    return files, compose, recipe


class OnyxRecipeFactory:
    def __init__(self, recipes, image_catalogue, database=None):
        self.recipes, self.image_catalogue = Path(recipes), Path(image_catalogue)
        self.database = Path(database) if database else None

    @staticmethod
    def _write(path: Path, content: bytes, mode=0o600, gid=0):
        if path.exists() or path.is_symlink():
            owned_path(path)
            if path.read_bytes() != content or path.stat().st_mode & 0o777 != mode or path.stat().st_gid != gid:
                fail("DEPLOYMENT_PREPARED_FILE_CHANGED")
            return
        fd, temporary = tempfile.mkstemp(prefix=".prepare-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(content); output.flush(); os.fsync(output.fileno())
            os.chmod(temporary, mode); os.chown(temporary, 0, gid); os.replace(temporary, path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    def prepare(self, row: dict):
        if os.geteuid() != 0: fail("DEPLOYMENT_FACTORY_ROOT_REQUIRED")
        identity(row); owned_path(self.recipes, directory=True)
        _, images = private_json(self.image_catalogue); catalogue(images)
        root = self.recipes / row["id"]; root.mkdir(mode=0o700, exist_ok=True); owned_path(root, directory=True)
        lock = os.open(root / ".prepare.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            marker = root / "preparation.json"
            if not marker.exists() and any(item.name != ".prepare.lock" for item in root.iterdir()):
                fail("DEPLOYMENT_PREPARATION_NOT_OWNED")
            if marker.exists():
                _, prior = private_json(marker)
                if prior != identity(row): fail("DEPLOYMENT_RECIPE_SCOPE_MISMATCH")
            else:
                self._write(marker, encoded(identity(row)))
            secret_path = root / "secrets.json"
            if secret_path.exists(): _, keys = private_json(secret_path)
            else:
                keys = {name: secrets.token_hex(32) if name == 'stateKey' else secrets.token_urlsafe(32) for name in SECRET_NAMES}
                self._write(secret_path, encoded(keys))
            config = root / "config"; config.mkdir(mode=0o700, exist_ok=True); owned_path(config, directory=True)
            search_claims = search_config.ensure_search_config(config, row["namespace"], images["searchGid"])
            files, compose, recipe = render(row, images, keys, root, search_claims)
            for name, (value, mode, gid) in files.items(): self._write(config / name, value.encode(), mode, gid)
            validate_compose(compose, recipe, root)
            self._write(root / "compose.json", encoded(compose)); self._write(root / "recipe.json", encoded(recipe))
        except BlockingIOError:
            fail("DEPLOYMENT_HELPER_BUSY")
        finally:
            os.close(lock)
