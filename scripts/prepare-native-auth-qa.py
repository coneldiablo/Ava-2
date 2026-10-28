#!/usr/bin/env python3
"""Prepare two empty native-auth QA databases; never attach production volumes.

Run on the acceptance host. Uses existing immutable image IDs from installed
database/cache containers, but never their data, network or credentials.
Secrets stay in root-only QA files. No application is started by this command.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import uuid


def run(args, *, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=90)
    if result.returncode:
        # Postgres/Docker errors may include credentials: keep output local.
        raise RuntimeError("NATIVE_QA_OPERATION_FAILED")
    return result.stdout.strip()


def image_from(container):
    value = run(["docker", "inspect", "--format", "{{.Image}}", container])
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise ValueError("NATIVE_QA_IMAGE_INVALID")
    return value


def private_file(path, text, uid=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(text)
    if uid is not None:
        os.chown(path, uid, uid)


def prepare(root):
    if os.geteuid() != 0 or root.parent != Path("/opt/ava-acceptance/ecosystem-20260914") or root.exists():
        raise ValueError("NEW_QA_DIRECTORY_REQUIRED")
    os.umask(0o077)
    memory = {key.rstrip(":"): int(value.split()[0]) for key, value in
              (line.split(":", 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    if memory['MemAvailable'] - 3 * 1024 * 1024 < memory['MemTotal'] * 0.2:
        raise RuntimeError('NATIVE_QA_CAPACITY_REQUIRED')
    root.mkdir(mode=0o700)
    run_id = uuid.uuid4().hex[:12]
    pg_image = image_from("onyx-relational_db-1")
    cache_image = image_from("onyx-cache-1")
    deployments = []
    for number in (1, 2):
        deployment_id = str(uuid.uuid4())
        namespace = "ava_" + deployment_id.replace("-", "")
        prefix = f"ava-auth-qa-{run_id}-{number}"
        directory = root / str(number)
        directory.mkdir(mode=0o700)
        admin_password, runtime_password, readonly_password = (secrets.token_urlsafe(32) for _ in range(3))
        readonly_role = namespace + '_ro'
        private_file(directory / "postgres.env", f"POSTGRES_USER=qa_admin\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD={admin_password}\n")
        native_env = {
            "AVA_BUSINESS_ID": str(900000 + number), "AVA_DEPLOYMENT_ID": deployment_id,
            "AVA_DEPLOYMENT_NAMESPACE": namespace, "POSTGRES_HOST": "database", "POSTGRES_PORT": "5432",
            "POSTGRES_DB": namespace, "POSTGRES_USER": namespace, "POSTGRES_PASSWORD": runtime_password,
            "REDIS_HOST": "cache", "REDIS_PORT": "6379", "AUTH_TYPE": "basic", "AUTH_BACKEND": "redis",
            "MULTI_TENANT": "false", "ENABLE_PAID_ENTERPRISE_EDITION_FEATURES": "false",
            "FILE_STORE_BACKEND": "s3", "S3_FILE_STORE_BUCKET_NAME": namespace.replace("_", "-") + "-files",
            "WEB_DOMAIN": f"https://qa-{run_id}-{number}.knowledge.meludtech.tech",
            "USER_AUTH_SECRET": secrets.token_urlsafe(48), "SESSION_EXPIRE_TIME_SECONDS": "3600",
            "POSTGRES_API_SERVER_POOL_SIZE": "3", "POSTGRES_API_SERVER_POOL_OVERFLOW": "2",
            "DISABLE_TELEMETRY": "true", "LOG_LEVEL": "error",
            "DB_READONLY_USER": readonly_role, "DB_READONLY_PASSWORD": readonly_password,
        }
        private_file(directory / "native.env", "".join(f"{key}={value}\n" for key, value in native_env.items()))
        run(["docker", "network", "create", "--internal", "--label", f"ava.qa.run={run_id}", prefix])
        run(["docker", "run", "-d", "--name", prefix + "-db", "--network", prefix, "--network-alias", "database",
             "--label", f"ava.qa.run={run_id}", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
             "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=256m", "--env-file", str(directory / "postgres.env"), pg_image])
        run(["docker", "run", "-d", "--name", prefix + "-cache", "--network", prefix, "--network-alias", "cache",
             "--label", f"ava.qa.run={run_id}", "--memory", "96m", "--cpus", "0.5", "--pids-limit", "64",
             "--read-only", "--tmpfs", "/data:rw,nosuid,nodev,noexec,size=32m", cache_image,
             "redis-server", "--save", "", "--appendonly", "no", "--maxmemory", "48mb", "--maxmemory-policy", "noeviction"])
        for attempt in range(30):
            # The image starts a temporary Unix-socket-only server during
            # initdb. Wait for TCP so its shutdown cannot race CREATE ROLE.
            ready = subprocess.run(["docker", "exec", prefix + "-db", "pg_isready", "-h", "127.0.0.1", "-U", "qa_admin", "-d", "postgres"],
                                   capture_output=True, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("NATIVE_QA_DATABASE_NOT_READY")
        # Values are generated internally with strict alphabets; SQL is sent on
        # stdin, not argv, and results/errors are never printed with passwords.
        run(["docker", "exec", "-i", prefix + "-db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "qa_admin", "-d", "postgres"],
            data=f"CREATE ROLE {namespace} LOGIN PASSWORD '{runtime_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\n"
                 f"CREATE ROLE {readonly_role} LOGIN PASSWORD '{readonly_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\n"
                 f"CREATE DATABASE {namespace} OWNER {namespace};\nREVOKE CONNECT ON DATABASE postgres FROM PUBLIC;\n"
                 f"REVOKE ALL ON DATABASE {namespace} FROM PUBLIC;\nGRANT CONNECT ON DATABASE {namespace} TO {readonly_role};\n")
        run(["docker", "exec", "-i", prefix + "-db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "qa_admin", "-d", namespace],
            data="CREATE EXTENSION IF NOT EXISTS pgcrypto;\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n")
        deployments.append({"business_id": 900000 + number, "deployment_id": deployment_id,
                            "namespace": namespace, "network": prefix, "database_container": prefix + "-db",
                            "cache_container": prefix + "-cache", "directory": str(directory)})
    manifest = {"qa_only": True, "run_id": run_id, "postgres_image": pg_image, "cache_image": cache_image,
                "production_volumes_mounted": False, "external_network": False, "deployments": deployments}
    private_file(root / "manifest.json", json.dumps(manifest, indent=2) + "\n")
    return {"qa_only": True, "empty_databases": len(deployments), "manifest": str(root / "manifest.json")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.directory.resolve())))
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit("NATIVE_QA_PREPARATION_FAILED; inspect only the newly labelled QA resources")
