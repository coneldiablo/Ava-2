import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ava_namespace", ROOT / "native_modules/onyx/ava_namespace.py")
namespace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(namespace)


def environment(seed="a"):
    value = "ava_" + seed * 32
    return {"AVA_DEPLOYMENT_NAMESPACE": value, "POSTGRES_DB": value, "POSTGRES_USER": value,
        "AUTH_TYPE": "basic", "AUTH_BACKEND": "redis", "S3_FILE_STORE_BUCKET_NAME": value.replace("_", "-") + "-files"}


@pytest.mark.parametrize("value", ["", "danswer_index", "public", "ava_../admin", "ava_*", "ava_" + "A" * 32])
def test_missing_or_unsafe_namespace_fails_closed(value):
    with pytest.raises(ValueError, match="AVA_DEPLOYMENT_NAMESPACE_REQUIRED"):
        namespace.deployment_namespace({"AVA_DEPLOYMENT_NAMESPACE": value})


def test_distinct_contours_use_distinct_buckets_and_indexes():
    a, b = environment("a"), environment("b")
    namespace.validate_runtime_storage(a)
    namespace.validate_runtime_storage(b)
    assert namespace.document_index_name(a) != namespace.document_index_name(b)
    assert namespace.bucket_name(a) != namespace.bucket_name(b)
    with pytest.raises(ValueError, match="AVA_SEARCH_INDEX_SCOPE_DENIED"):
        namespace.validate_index_name(namespace.document_index_name(b), a)


@pytest.mark.parametrize("suffix", ["*", ",other", "/_all", ":admin", "_../x", "_", "_" + "a" * 97])
def test_wildcard_alias_path_and_malformed_indexes_rejected(suffix):
    env = environment()
    with pytest.raises(ValueError, match="AVA_SEARCH_INDEX_SCOPE_DENIED"):
        namespace.validate_index_name(namespace.document_index_name(env) + suffix, env)


def test_embedding_migration_suffix_stays_in_own_scope():
    env = environment()
    value = namespace.document_index_name(env) + "_embedding-v2_20260914"
    assert namespace.validate_index_name(value, env) == value


@pytest.mark.parametrize("patch", [{"POSTGRES_DB": "postgres"}, {"POSTGRES_USER": "postgres"},
    {"MULTI_TENANT": "true"}, {"AUTH_TYPE": "disabled"}, {"AUTH_BACKEND": "jwt"},
    {"S3_FILE_STORE_BUCKET_NAME": "onyx-file-store-bucket"}, {"FILE_STORE_BACKEND": "postgres"}])
def test_no_global_database_bucket_anonymous_or_stateless_auth(patch):
    with pytest.raises(ValueError, match="AVA_"):
        namespace.validate_runtime_storage({**environment(), **patch})
