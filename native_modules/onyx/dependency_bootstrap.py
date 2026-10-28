#!/usr/bin/env python3
"""Idempotent, fail-closed dependency bootstrap for one Onyx contour."""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable


NAME = re.compile(r"ava_[0-9a-f]{32}\Z")
SECRET = re.compile(r"[A-Za-z0-9_-]{43}\Z")


class BootstrapError(RuntimeError):
    """A stable error that does not include credentials or response bodies."""


@dataclass(frozen=True)
class Response:
    status: int
    body: object


Request = Callable[[str, str, tuple[str, str], object | None], Response]


def _json_request(base_url: str, ca_file: str, client_cert: str, client_key: str, timeout: float = 10) -> Request:
    if (ca_file, client_cert, client_key) != ("/run/ava-search-ca/ca.pem", "/run/ava-search-ca/admin.pem", "/run/ava-search-ca/admin-key.pem"):
        raise BootstrapError("OPENSEARCH_CA_INVALID")
    try:
        admin_context = ssl.create_default_context(cafile=ca_file)
        admin_context.load_cert_chain(client_cert, client_key)
        basic_context = ssl.create_default_context(cafile=ca_file)
    except OSError as exc:
        raise BootstrapError("OPENSEARCH_CA_INVALID") from exc

    def request(method: str, path: str, auth: tuple[str, str], body: object | None = None) -> Response:
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Accept": "application/json"}
        context = basic_context if auth[0] else admin_context
        if auth[0]:
            token = base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode("ascii")
            headers["Authorization"] = "Basic " + token
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=context) as result:
                raw = result.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise BootstrapError("OPENSEARCH_RESPONSE_TOO_LARGE")
                return Response(result.status, json.loads(raw) if raw else {})
        except urllib.error.HTTPError as exc:
            # Status is enough for reconciliation. Never retain a body which can
            # contain security configuration or credentials.
            return Response(exc.code, {})
        except (OSError, ValueError, UnicodeError) as exc:
            raise BootstrapError("OPENSEARCH_UNAVAILABLE") from exc

    return request


def opensearch_role(namespace: str) -> dict:
    if not NAME.fullmatch(namespace):
        raise BootstrapError("BOOTSTRAP_SCOPE_INVALID")
    primary = namespace + "_documents"
    return {
        "cluster_permissions": [
            "cluster_composite_ops",
            "cluster_monitor",
            "cluster:admin/ingest/pipeline/*",
            "cluster:admin/search/pipeline/*",
            "cluster:admin/settings/update",
        ],
        "index_permissions": [{
            "index_patterns": [primary, primary + "_*"],
            "allowed_actions": ["crud", "create_index", "manage"],
        }],
        "tenant_permissions": [],
        "description": "AVA owned Onyx runtime for " + namespace,
    }


def _owned_role(row: object, desired: dict) -> bool:
    if not isinstance(row, dict):
        return False
    if row.get("reserved", False) is not False or row.get("hidden", False) is not False or row.get("static", False) is not False:
        return False
    if row.get("description") != desired["description"] or row.get("cluster_permissions") != desired["cluster_permissions"] or row.get("tenant_permissions") != []:
        return False
    permissions = row.get("index_permissions")
    if not isinstance(permissions, list) or len(permissions) != 1 or not isinstance(permissions[0], dict):
        return False
    permission = permissions[0]
    if permission.get("index_patterns") != desired["index_permissions"][0]["index_patterns"] or permission.get("allowed_actions") != desired["index_permissions"][0]["allowed_actions"]:
        return False
    # OpenSearch adds these empty fields to a role GET response. Non-empty
    # values would grant or mask a different data scope and are a conflict.
    return permission.get("dls", "") == "" and permission.get("fls", []) == [] and permission.get("masked_fields", []) == []


def reconcile_opensearch(
    namespace: str,
    runtime_password: str,
    request: Request,
    attempts: int = 120,
    pause: Callable[[float], None] = time.sleep,
) -> None:
    """Create or replace the scoped role/user, then prove runtime ownership.

    PUT operations make retries safe after a lost response. The final reads use
    runtime credentials, so an acknowledged admin write alone is not proof.
    """
    if not NAME.fullmatch(namespace) or not SECRET.fullmatch(runtime_password):
        raise BootstrapError("BOOTSTRAP_INPUT_INVALID")
    role_name, user_name = namespace + "_runtime", namespace + "_runtime"
    admin, runtime = ("", ""), (user_name, runtime_password)
    for number in range(attempts):
        ready = request("GET", "/_plugins/_security/authinfo", admin)
        if ready.status == 200:
            break
        if ready.status in (401, 403):
            raise BootstrapError("OPENSEARCH_ADMIN_REJECTED")
        if number + 1 == attempts:
            raise BootstrapError("OPENSEARCH_UNAVAILABLE")
        pause(1)

    role_path = "/_plugins/_security/api/roles/" + role_name
    user_path = "/_plugins/_security/api/internalusers/" + user_name
    desired_role = opensearch_role(namespace)
    existing_role = request("GET", role_path, admin)
    if existing_role.status == 200:
        row = existing_role.body.get(role_name) if isinstance(existing_role.body, dict) else None
        if not _owned_role(row, desired_role):
            raise BootstrapError("OPENSEARCH_RESOURCE_OWNERSHIP_CONFLICT")
    elif existing_role.status != 404:
        raise BootstrapError("OPENSEARCH_ROLE_READ_FAILED")
    existing_user = request("GET", user_path, admin)
    if existing_user.status == 200:
        row = existing_user.body.get(user_name) if isinstance(existing_user.body, dict) else None
        if (not isinstance(row, dict) or row.get("roles") != [role_name]
                or row.get("attributes") != {"ava_namespace": namespace}
                or row.get("backend_roles", []) != []
                or row.get("reserved", False) is not False
                or row.get("hidden", False) is not False):
            raise BootstrapError("OPENSEARCH_RESOURCE_OWNERSHIP_CONFLICT")
    elif existing_user.status != 404:
        raise BootstrapError("OPENSEARCH_USER_READ_FAILED")
    # Validate both names before writing either. A foreign user must not cause
    # even its paired role to be replaced as a side effect of a failed replay.
    role = request("PUT", role_path, admin, desired_role)
    if role.status not in (200, 201):
        raise BootstrapError("OPENSEARCH_ROLE_REJECTED")
    user = request("PUT", user_path, admin, {
        "password": runtime_password,
        "opendistro_security_roles": [role_name],
        "attributes": {"ava_namespace": namespace},
    })
    if user.status not in (200, 201):
        raise BootstrapError("OPENSEARCH_USER_REJECTED")

    # Re-read after both writes. This reconciles an earlier write whose response
    # was lost and verifies that this exact user owns the exact role.
    auth = request("GET", "/_plugins/_security/authinfo", runtime)
    body = auth.body if isinstance(auth.body, dict) else {}
    roles = body.get("roles", [])
    if auth.status != 200 or body.get("user_name") != user_name or roles != [role_name]:
        raise BootstrapError("OPENSEARCH_RUNTIME_PROOF_FAILED")
    proof_index = namespace + "_documents_bootstrap"
    present = request("HEAD", "/" + proof_index, runtime)
    if present.status == 404:
        created = request("PUT", "/" + proof_index, runtime, {})
        if created.status not in (200, 201):
            raise BootstrapError("OPENSEARCH_RUNTIME_PROOF_FAILED")
    elif present.status != 200:
        raise BootstrapError("OPENSEARCH_RUNTIME_PROOF_FAILED")
    deleted = request("DELETE", "/" + proof_index, runtime)
    if deleted.status not in (200, 404):
        raise BootstrapError("OPENSEARCH_RUNTIME_PROOF_FAILED")
    other_namespace = "ava_" + ("0" * 32 if namespace != "ava_" + "0" * 32 else "1" * 32)
    if request("HEAD", "/" + other_namespace + "_documents", runtime).status != 403:
        raise BootstrapError("OPENSEARCH_RUNTIME_OVERPRIVILEGED")
    forbidden = request("GET", "/_plugins/_security/api/internalusers", runtime)
    if forbidden.status != 403:
        raise BootstrapError("OPENSEARCH_RUNTIME_OVERPRIVILEGED")


def minio_policy(namespace: str) -> dict:
    if not NAME.fullmatch(namespace):
        raise BootstrapError("BOOTSTRAP_SCOPE_INVALID")
    bucket = namespace.replace("_", "-") + "-files"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Deny", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::" + bucket + "/.ava-ownership.json"]},
            {"Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"], "Resource": ["arn:aws:s3:::" + bucket]},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": ["arn:aws:s3:::" + bucket + "/*"]},
        ],
    }


def runtime_object_user(namespace: str) -> str:
    if not NAME.fullmatch(namespace):
        raise BootstrapError("BOOTSTRAP_SCOPE_INVALID")
    return "ava" + namespace.removeprefix("ava_")[:17]


def minio_bootstrap_script(namespace: str) -> str:
    """Return a fixed mc workflow whose secret inputs are files or stdin."""
    policy_name = namespace.replace("_", "-") + "-runtime"
    bucket = namespace.replace("_", "-") + "-files"
    policy = "/run/ava/minio-policy.json"
    user = runtime_object_user(namespace)
    return f"""#!/bin/sh
set -eu
umask 077
mkdir -p /tmp/mc
cp /run/ava/mc-config.json /tmp/mc/config.json
i=0
until MC_CONFIG_DIR=/tmp/mc /usr/bin/mc ready admin >/dev/null 2>&1; do
  i=$((i + 1)); [ \"$i\" -lt 60 ] || exit 41; sleep 1
done
if MC_CONFIG_DIR=/tmp/mc /usr/bin/mc stat admin/{bucket} >/dev/null 2>&1; then
  MC_CONFIG_DIR=/tmp/mc /usr/bin/mc cat admin/{bucket}/.ava-ownership.json | cmp -s - /run/ava/dependency-claims.json || exit 43
else
  # With no matching bucket claim, identically named IAM resources are foreign.
  policy_info=$(MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin policy info --json admin {policy_name} 2>&1) && exit 44
  case "$policy_info" in *XMinioAdminNoSuchPolicy*) ;; *) exit 46;; esac
  user_info=$(MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin user info --json admin {user} 2>&1) && exit 44
  case "$user_info" in *XMinioAdminNoSuchUser*) ;; *) exit 46;; esac
  MC_CONFIG_DIR=/tmp/mc /usr/bin/mc mb admin/{bucket} >/dev/null
  MC_CONFIG_DIR=/tmp/mc /usr/bin/mc cp /run/ava/dependency-claims.json admin/{bucket}/.ava-ownership.json >/dev/null
fi
# These commands are convergent: they replace the policy and the user's secret.
MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin policy create admin {policy_name} {policy} >/dev/null
if ! MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin user add admin </run/ava/minio-runtime-credentials >/dev/null 2>&1; then :; fi
if ! MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin policy attach admin {policy_name} --user {user} >/dev/null 2>&1; then :; fi
runtime_info=$(MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin user info --json admin {user})
case "$runtime_info" in *'"accessKey":"{user}"'*) ;; *) exit 45;; esac
case "$runtime_info" in *'"policyName":"{policy_name}"'*) ;; *) exit 45;; esac
case "$runtime_info" in *'"userStatus":"enabled"'*) ;; *) exit 45;; esac
# Depending on the pinned mc/server pair, an empty membership is emitted or
# omitted. A non-empty group would add permissions outside the owned policy.
case "$runtime_info" in *'"memberOf":[]'*) ;; *'"memberOf":'*) exit 45;; esac
probe=/tmp/ava-bootstrap-proof
printf proof >\"$probe\"
MC_CONFIG_DIR=/tmp/mc /usr/bin/mc cp \"$probe\" runtime/{bucket}/.ava-bootstrap-proof >/dev/null
MC_CONFIG_DIR=/tmp/mc /usr/bin/mc stat runtime/{bucket}/.ava-bootstrap-proof >/dev/null
MC_CONFIG_DIR=/tmp/mc /usr/bin/mc rm runtime/{bucket}/.ava-bootstrap-proof >/dev/null
# A runtime principal must not read MinIO administration state.
if MC_CONFIG_DIR=/tmp/mc /usr/bin/mc admin info runtime >/dev/null 2>&1; then exit 42; fi
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("opensearch", nargs="?")
    args = parser.parse_args()
    if args.opensearch != "opensearch":
        raise BootstrapError("BOOTSTRAP_MODE_INVALID")
    base_url = os.environ.get("AVA_OPENSEARCH_URL", "https://search:9200")
    if base_url != "https://search:9200":
        raise BootstrapError("BOOTSTRAP_ENDPOINT_INVALID")
    reconcile_opensearch(
        os.environ.get("AVA_DEPLOYMENT_NAMESPACE", ""),
        Path("/run/ava-search-ca/runtime-password").read_text(encoding="utf-8").strip(),
        _json_request(base_url, "/run/ava-search-ca/ca.pem", "/run/ava-search-ca/admin.pem", "/run/ava-search-ca/admin-key.pem"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
