"""AVA-owned storage boundary for isolated Onyx Community deployments.

No Enterprise tenancy/group implementation is used here. Search-cluster ACLs
and object-store policies remain mandatory: namespacing is defense in depth.
"""
import os
import re
from collections.abc import Mapping


def deployment_namespace(env: Mapping[str, str] | None = None) -> str:
    value = (os.environ if env is None else env).get("AVA_DEPLOYMENT_NAMESPACE", "")
    if not re.fullmatch(r"ava_[0-9a-f]{32}", value):
        raise ValueError("AVA_DEPLOYMENT_NAMESPACE_REQUIRED")
    return value


def document_index_name(env: Mapping[str, str] | None = None) -> str:
    return deployment_namespace(env) + "_documents"


def validate_index_name(value: str, env: Mapping[str, str] | None = None) -> str:
    prefix = document_index_name(env)
    # Embedding migrations may suffix an index but cannot select another
    # deployment, aliases, wildcard/comma expressions or system indices.
    if not isinstance(value, str) or not re.fullmatch(re.escape(prefix) + r"(?:_[a-z0-9][a-z0-9_-]{0,95})?", value):
        raise ValueError("AVA_SEARCH_INDEX_SCOPE_DENIED")
    return value


def bucket_name(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    expected = deployment_namespace(source).replace("_", "-") + "-files"
    if source.get("S3_FILE_STORE_BUCKET_NAME") != expected:
        raise ValueError("AVA_FILE_BUCKET_SCOPE_DENIED")
    return expected


def validate_runtime_storage(env: Mapping[str, str] | None = None) -> None:
    source = os.environ if env is None else env
    namespace = deployment_namespace(source)
    if source.get("MULTI_TENANT", "false").lower() != "false":
        raise ValueError("AVA_COMMUNITY_SINGLE_CONTOUR_REQUIRED")
    if source.get("POSTGRES_DB") != namespace or source.get("POSTGRES_USER") != namespace:
        raise ValueError("AVA_DATABASE_SCOPE_DENIED")
    if source.get("AUTH_TYPE") != "basic" or source.get("AUTH_BACKEND") not in ("redis", "postgres"):
        raise ValueError("AVA_STATEFUL_NATIVE_AUTH_REQUIRED")
    if source.get("FILE_STORE_BACKEND", "s3") != "s3":
        raise ValueError("AVA_FILE_STORE_CONFIGURATION_REQUIRED")
    bucket_name(source)
