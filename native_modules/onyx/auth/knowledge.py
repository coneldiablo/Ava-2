"""Worker-only canonical knowledge ingestion for Community Onyx.

This module is deliberately not an HTTP route and has no ``ee`` imports.  The
provisioning peer may call it after it has authenticated the deployment and
fenced the worker lease.  The caller supplies a *private* document set that
was created during deployment bootstrap; this module only attaches the two
already-admitted Community users and indexes canonical AVA documents.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any
from urllib.parse import quote
from uuid import UUID


class KnowledgeDenied(Exception):
    """The request is outside the worker's immutable deployment scope."""


class KnowledgeUnavailable(Exception):
    """Community dependencies or indexing state are unavailable."""


@dataclass(frozen=True)
class KnowledgeScope:
    business_id: int
    deployment_id: str
    native_scope: str
    revision: int

    def check(self, value: dict[str, Any]) -> None:
        if (set(value) != {"businessId", "deploymentId", "nativeScope", "revision"}
                or type(value["businessId"]) is not int
                or type(value["revision"]) is not int
                or self.business_id < 1 or self.revision < 1
                or not isinstance(self.deployment_id, str)
                or not isinstance(self.native_scope, str)
                or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", self.deployment_id)
                or not re.fullmatch(r"ava_[0-9a-f]{32}", self.native_scope)
                or self.native_scope != "ava_" + self.deployment_id.replace("-", "")):
            raise KnowledgeDenied()
        if (value["businessId"], value["deploymentId"], value["nativeScope"], value["revision"]) != (
            self.business_id, self.deployment_id, self.native_scope, self.revision
        ):
            raise KnowledgeDenied()


def _user_id(value: str) -> UUID:
    try:
        result = UUID(value)
    except (TypeError, ValueError):
        raise KnowledgeDenied() from None
    if str(result) != value:
        raise KnowledgeDenied()
    return result


def _document(scope: KnowledgeScope, value: dict[str, Any]) -> Any:
    """Build an Onyx Document from the canonical AVA wire shape."""
    if not isinstance(value, dict) or set(value) != {"id", "title", "text", "source_id", "content_hash"}:
        raise KnowledgeDenied()
    expected_prefix = f"ava:{scope.business_id}:knowledge:"
    if not isinstance(value["id"], str) or not value["id"].startswith(expected_prefix):
        raise KnowledgeDenied()
    suffix = value["id"][len(expected_prefix):]
    if not suffix.isdigit() or int(suffix) < 1 or value["source_id"] != suffix:
        raise KnowledgeDenied()
    if (not all(isinstance(value[key], str) and value[key].strip() for key in ("title", "text", "source_id", "content_hash"))
            or not re.fullmatch(r"(?:[0-9a-f]{32}|[0-9a-f]{64})", value["content_hash"])):
        raise KnowledgeDenied()
    try:
        from onyx.connectors.models import Document, DocumentBase
    except ImportError:
        raise KnowledgeUnavailable() from None
    base = DocumentBase(
        id=value["id"],
        semantic_identifier=value["title"],
        title=value["title"],
        sections=[{"type": "text", "text": value["text"], "link": f"/hotels/{scope.business_id}/kb/{value['source_id']}"}],
        source="ingestion_api",
        metadata={
            "business_id": str(scope.business_id),
            "ava_entity_type": "knowledge",
            "ava_source_id": value["source_id"],
            "ava_content_hash": value["content_hash"],
        },
        from_ingestion_api=True,
    )
    return Document.from_base(base)


def share_private_document_set(
    db_session: Any,
    *,
    document_set_id: int,
    owner_user_id: str,
    runtime_user_id: str,
) -> None:
    """Make an existing private Community set visible to exactly two users.

    This only writes the Community ``document_set__user`` relation.  It never
    creates groups, grants permissions, or changes ``is_public``.  The set and
    both users must already exist; an unknown ID is a hard failure.
    """
    if type(document_set_id) is not int or document_set_id < 1:
        raise KnowledgeDenied()
    owner = _user_id(owner_user_id)
    runtime = _user_id(runtime_user_id)
    try:
        from onyx.db.models import DocumentSet, DocumentSet__User, User
    except ImportError:
        raise KnowledgeUnavailable() from None
    document_set = db_session.get(DocumentSet, document_set_id)
    users = [db_session.get(User, user_id) for user_id in (owner, runtime)]
    if document_set is None or document_set.is_public or any(user is None or not user.is_active for user in users):
        raise KnowledgeDenied()
    existing = {
        row.user_id
        for row in db_session.query(DocumentSet__User).filter(
            DocumentSet__User.document_set_id == document_set_id
        ).all()
    }
    wanted = {owner, runtime}
    # A pre-existing third user is not silently widened or removed by a worker.
    if existing - wanted:
        raise KnowledgeDenied()
    for user_id in wanted - existing:
        db_session.add(DocumentSet__User(document_set_id=document_set_id, user_id=user_id))
    db_session.flush()
    actual = {
        row.user_id
        for row in db_session.query(DocumentSet__User).filter(
            DocumentSet__User.document_set_id == document_set_id
        ).all()
    }
    if actual != wanted:
        raise KnowledgeDenied()


def ingest_canonical_document(
    db_session: Any,
    *,
    scope: KnowledgeScope,
    document: dict[str, Any],
    owner_cc_pair_id: int,
    runtime_cc_pair_id: int,
    document_set_id: int,
    owner_user_id: str,
    runtime_user_id: str,
) -> dict[str, Any]:
    """Index one canonical hotel document and attach its private set users.

    The caller must run this in the worker process after validating the module
    deployment lease.  The function intentionally does not accept a user,
    API key, group, or permission override.
    """
    if (type(owner_cc_pair_id) is not int or owner_cc_pair_id < 1
            or type(runtime_cc_pair_id) is not int or runtime_cc_pair_id < 1
            or owner_cc_pair_id == runtime_cc_pair_id):
        raise KnowledgeDenied()
    doc = _document(scope, document)
    share_private_document_set(
        db_session,
        document_set_id=document_set_id,
        owner_user_id=owner_user_id,
        runtime_user_id=runtime_user_id,
    )
    try:
        from onyx.db.connector_credential_pair import get_connector_credential_pair_from_id
        from onyx.db.models import ConnectorCredentialPair, DocumentSet__ConnectorCredentialPair
        from onyx.db.search_settings import get_active_search_settings, get_current_search_settings, get_secondary_search_settings
        from onyx.document_index.factory import get_all_document_indices
        from onyx.connectors.models import IndexAttemptMetadata
        from onyx.indexing.adapters.document_indexing_adapter import DocumentIndexingBatchAdapter
        from onyx.indexing.embedder import DefaultIndexingEmbedder
        from onyx.indexing.indexing_pipeline import run_indexing_pipeline
        from shared_configs.contextvars import get_current_tenant_id
    except ImportError:
        raise KnowledgeUnavailable() from None
    pairs = []
    for pair_id, user_id in ((owner_cc_pair_id, owner_user_id), (runtime_cc_pair_id, runtime_user_id)):
        pair = get_connector_credential_pair_from_id(db_session=db_session, cc_pair_id=pair_id)
        pair_source = getattr(pair.connector.source, "value", pair.connector.source) if pair and pair.connector else None
        pair_access = getattr(pair.access_type, "value", pair.access_type) if pair else None
        if (pair is None or pair_source != "ingestion_api"
                or str(pair_access).lower() != "private"
                or pair.credential is None or str(pair.credential.user_id) != user_id):
            raise KnowledgeDenied()
        pairs.append(pair)
    mapped = {
        row.connector_credential_pair_id
        for row in db_session.query(DocumentSet__ConnectorCredentialPair).filter(
            DocumentSet__ConnectorCredentialPair.document_set_id == document_set_id
        ).all()
        if row.is_current is True
    }
    if mapped != {owner_cc_pair_id, runtime_cc_pair_id}:
        raise KnowledgeDenied()
    active = get_active_search_settings(db_session)
    current = get_current_search_settings(db_session)
    indices = get_all_document_indices(active.primary, None, None)
    results = []
    for pair in pairs:
        adapter = DocumentIndexingBatchAdapter(
            connector_id=pair.connector_id,
            credential_id=pair.credential_id,
            tenant_id=get_current_tenant_id(),
            index_attempt_metadata=IndexAttemptMetadata(
                connector_id=pair.connector_id, credential_id=pair.credential_id
            ),
        )
        results.append(run_indexing_pipeline(
            embedder=DefaultIndexingEmbedder.from_db_search_settings(search_settings=current),
            document_indices=indices,
            ignore_time_skip=True,
            db_session=db_session,
            tenant_id=get_current_tenant_id(),
            document_batch=[doc],
            request_id=None,
            adapter=adapter,
        ))
    if active.secondary:
        secondary = get_secondary_search_settings(db_session)
        if secondary is None:
            raise KnowledgeUnavailable()
        for pair in pairs:
            secondary_adapter = DocumentIndexingBatchAdapter(
                connector_id=pair.connector_id,
                credential_id=pair.credential_id,
                tenant_id=get_current_tenant_id(),
                index_attempt_metadata=IndexAttemptMetadata(
                    connector_id=pair.connector_id, credential_id=pair.credential_id
                ),
            )
            run_indexing_pipeline(
                embedder=DefaultIndexingEmbedder.from_db_search_settings(search_settings=secondary),
                document_indices=get_all_document_indices(active.secondary, None, None),
                ignore_time_skip=True,
                index_to_secondary=True,
                db_session=db_session,
                tenant_id=get_current_tenant_id(),
                document_batch=[doc],
                request_id=None,
                adapter=secondary_adapter,
            )
    return {"document_id": document["id"], "native_document_id": doc.id,
            "already_existed": all(result.new_docs == 0 for result in results),
            "document_set_id": document_set_id}


def delete_canonical_document(
    db_session: Any,
    *,
    scope: KnowledgeScope,
    document_id: str,
    owner_cc_pair_id: int,
    runtime_cc_pair_id: int,
    document_set_id: int,
    owner_user_id: str,
    runtime_user_id: str,
) -> dict[str, Any]:
    """Delete one canonical document from Community indexes and all DB ACL rows.

    The worker must prove the same two private pairs and exact private set
    membership used by ingestion.  A missing document is an idempotent success,
    but scope and ownership are still checked before returning.
    """
    if (type(owner_cc_pair_id) is not int or owner_cc_pair_id < 1
            or type(runtime_cc_pair_id) is not int or runtime_cc_pair_id < 1
            or owner_cc_pair_id == runtime_cc_pair_id
            or type(document_set_id) is not int or document_set_id < 1):
        raise KnowledgeDenied()
    if (not isinstance(document_id, str)
            or not re.fullmatch(rf"ava:{scope.business_id}:knowledge:[1-9][0-9]*", document_id)):
        raise KnowledgeDenied()
    share_private_document_set(
        db_session,
        document_set_id=document_set_id,
        owner_user_id=owner_user_id,
        runtime_user_id=runtime_user_id,
    )
    try:
        from onyx.db.connector_credential_pair import get_connector_credential_pair_from_id
        from onyx.db.document import delete_documents_complete, get_document
        from onyx.db.models import DocumentByConnectorCredentialPair, DocumentSet__ConnectorCredentialPair
        from onyx.db.search_settings import get_active_search_settings
        from onyx.document_index.factory import get_all_document_indices
    except ImportError:
        raise KnowledgeUnavailable() from None
    expected_pairs = set()
    for pair_id, user_id in ((owner_cc_pair_id, owner_user_id), (runtime_cc_pair_id, runtime_user_id)):
        pair = get_connector_credential_pair_from_id(db_session=db_session, cc_pair_id=pair_id)
        pair_source = getattr(pair.connector.source, "value", pair.connector.source) if pair and pair.connector else None
        pair_access = getattr(pair.access_type, "value", pair.access_type) if pair else None
        if (pair is None or pair_source != "ingestion_api"
                or str(pair_access).lower() != "private"
                or pair.credential is None or str(pair.credential.user_id) != user_id):
            raise KnowledgeDenied()
        expected_pairs.add((pair.connector_id, pair.credential_id))
    mapped = {
        row.connector_credential_pair_id
        for row in db_session.query(DocumentSet__ConnectorCredentialPair).filter(
            DocumentSet__ConnectorCredentialPair.document_set_id == document_set_id
        ).all()
        if row.is_current is True
    }
    if mapped != {owner_cc_pair_id, runtime_cc_pair_id}:
        raise KnowledgeDenied()
    native_document_id = quote(document_id, safe="")
    document = get_document(document_id=native_document_id, db_session=db_session)
    if document is None:
        return {"document_id": document_id, "native_document_id": native_document_id,
                "deleted": False, "document_set_id": document_set_id}
    if document.from_ingestion_api is not True:
        raise KnowledgeDenied()
    associations = db_session.query(DocumentByConnectorCredentialPair).filter(
        DocumentByConnectorCredentialPair.id == native_document_id
    ).all()
    actual_pairs = {(row.connector_id, row.credential_id) for row in associations}
    if actual_pairs != expected_pairs:
        raise KnowledgeDenied()
    active = get_active_search_settings(db_session)
    for document_index in get_all_document_indices(active.primary, active.secondary, None):
        document_index.delete(native_document_id, chunk_count=document.chunk_count)
    delete_documents_complete(db_session, [native_document_id])
    return {"document_id": document_id, "native_document_id": native_document_id,
            "deleted": True, "document_set_id": document_set_id}
