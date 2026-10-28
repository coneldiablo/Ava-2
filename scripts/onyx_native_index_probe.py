"""Read-only v4.7 default-index probe; no LLM, admin HTTP, or content output.

The root bootstrap executes this reviewed source in the exact labelled API
container. Retrieval uses the same DocumentIndex and ACL builder as the pinned
query backend, with the private runtime persona's document-set scope. Random
retrieval avoids transmitting or logging a customer query. It proves indexed
source availability, not semantic answer quality.
"""
from __future__ import annotations

from urllib.parse import quote
from uuid import UUID


class IndexProbeDenied(ValueError):
    pass


def check(condition):
    if not condition:
        raise IndexProbeDenied("ONYX_NATIVE_INDEX_READBACK_FAILED")


def index_document(chunks, expected, business_id):
    check(isinstance(chunks, list) and 0 < len(chunks) <= 3)
    for chunk in chunks:
        metadata = getattr(chunk, "metadata", None)
        check(isinstance(metadata, dict))
        def single(value):
            return value[0] if isinstance(value, list) and len(value) == 1 else value
        source = getattr(chunk, "source_type", None)
        check(getattr(source, "value", source) == "ingestion_api"
              and getattr(chunk, "hidden", None) is False
              and getattr(chunk, "document_id", None) == expected["native_id"]
              and single(metadata.get("business_id")) == str(business_id)
              and single(metadata.get("ava_entity_type")) == "knowledge"
              and single(metadata.get("ava_source_id")) == expected["source_id"]
              and single(metadata.get("ava_content_hash")) == expected["content_hash"])
    return {"onyx_document_id": expected["native_id"], "source_id": expected["source_id"],
            "content_hash": expected["content_hash"]}


def probe_index(index, filters, documents, business_id):
    check(isinstance(documents, list) and len(documents) <= 1000)
    result = {}
    for expected in documents:
        raw_id = f"ava:{business_id}:knowledge:{expected['source_id']}"
        check(expected["native_id"] == quote(raw_id, safe="") and raw_id not in result)
        # Tags are OR within a tag list in v4.7. Use one source tag and validate
        # every returned chunk's complete business/source/current-hash tuple.
        chunks = index.random_retrieval(filters=filters("ava_source_id", expected["source_id"]), num_to_retrieve=3)
        result[raw_id] = index_document(chunks, expected, business_id)
    if not documents:
        # An ACK for removal of the last source cannot substitute for its
        # actual disappearance from the runtime's private live index.
        check(index.random_retrieval(filters=filters("ava_entity_type", "knowledge"), num_to_retrieve=1) == [])
    # A foreign-business source must not be visible even within this document
    # set. Any result, including an own document from an ignored filter, fails.
    check(index.random_retrieval(filters=filters("business_id", str(business_id + 1)), num_to_retrieve=1) == [])
    return {"indexReadinessVerified": True, "indexProbeMethod": "default_document_index_random_acl_v1",
            "indexedDocuments": result}


def run_probe(payload):
    from onyx.auth.permissions import has_global_permission
    from onyx.configs.constants import DocumentSource
    from onyx.context.search.models import IndexFilters, Tag, TimeRange
    from onyx.context.search.preprocessing.access_filters import build_access_filters_for_user
    from onyx.db.engine.sql_engine import SqlEngine, get_session_with_current_tenant
    from onyx.db.enums import Permission
    from onyx.db.models import User
    from onyx.db.persona import get_persona_by_id
    from onyx.db.search_settings import get_current_search_settings
    from onyx.document_index.factory import get_default_document_index
    from shared_configs.contextvars import get_current_tenant_id

    scope, binding = payload["scope"], payload["binding"]
    expected_name = "ava-native-" + scope["deploymentId"].replace("-", "") + "-knowledge"
    check(binding["document_set_name"] == expected_name)
    SqlEngine.init_engine(pool_size=1, max_overflow=0)
    with get_session_with_current_tenant() as db:
        user = db.get(User, UUID(payload["runtime"]["nativeUserId"]))
        check(user is not None and user.is_active
              and has_global_permission(user, Permission.READ_SEARCH)
              and not has_global_permission(user, Permission.FULL_ADMIN_PANEL_ACCESS))
        persona = get_persona_by_id(persona_id=binding["persona_id"], user=user, db_session=db, is_for_edit=False)
        check(persona is not None and persona.is_public is False
              and {str(item.id) for item in persona.users} == {str(user.id)}
              and {item.id for item in persona.tools} == {binding["search_tool_id"]}
              and len(persona.document_sets) == 1
              and persona.document_sets[0].id == binding["document_set_id"]
              and persona.document_sets[0].name == expected_name
              and persona.document_sets[0].is_public is False
              and not persona.attached_documents and not persona.hierarchy_nodes)
        acl = build_access_filters_for_user(user, db)
        check(isinstance(acl, list) and bool(acl) and all(isinstance(value, str) and value for value in acl))
        def filters(tag_key, tag_value):
            return IndexFilters(source_type=[DocumentSource.INGESTION_API], document_set=[expected_name],
                tags=[Tag(tag_key=tag_key, tag_value=tag_value)], access_control_list=acl,
                tenant_id=get_current_tenant_id(), updated_at_range=(
                    TimeRange(start=persona.search_start_date) if persona.search_start_date else None))
        index = get_default_document_index(get_current_search_settings(db), None, db)
        return probe_index(index, filters, payload["documents"], scope["businessId"])
