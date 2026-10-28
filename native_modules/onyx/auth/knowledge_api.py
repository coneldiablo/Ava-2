"""Worker-side validator and revision fence for isolated Community knowledge."""
from __future__ import annotations

import asyncio
import re
from typing import Any, Callable

from .core import Denied, Unavailable, identifier, integer
from .knowledge import KnowledgeDenied, KnowledgeScope, KnowledgeUnavailable, delete_canonical_document, ingest_canonical_document
from .knowledge_bootstrap import KnowledgeBootstrap, bootstrap_private_knowledge

BOOTSTRAP_FIELDS = {"businessId", "deploymentId", "nativeScope", "revision", "modelConfigurationId", "ownerUserId", "runtimeUserId"}
UPSERT_FIELDS = {"businessId", "deploymentId", "nativeScope", "revision", "ownerUserId", "runtimeUserId", "ownerCcPairId", "runtimeCcPairId", "documentSetId", "document"}
DELETE_FIELDS = {"businessId", "deploymentId", "nativeScope", "revision", "ownerUserId", "runtimeUserId", "ownerCcPairId", "runtimeCcPairId", "documentSetId", "documentId"}
MAX_DOCUMENT_TEXT = 512 * 1024
MAX_DOCUMENT_TITLE = 512


class KnowledgeAPI:
    """No HTTP, native database, or credential imports until actual work."""

    def __init__(self, config: Any, state: Any, *, session_factory: Callable[[], Any] | None = None,
                 state_factory: Callable[[], Any] | None = None,
                 bootstrap: Callable[..., dict[str, Any]] = bootstrap_private_knowledge,
                 ingest: Callable[..., dict[str, Any]] = ingest_canonical_document,
                 delete: Callable[..., dict[str, Any]] = delete_canonical_document) -> None:
        self.config, self.state, self.session_factory, self.state_factory = config, state, session_factory, state_factory
        self.bootstrap, self.ingest, self.delete = bootstrap, ingest, delete
        self.lock = asyncio.Lock()

    def _scope(self, data: dict[str, Any], state: Any | None = None) -> KnowledgeScope:
        scope_data = {key: data[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")}
        scope = KnowledgeScope(self.config.business_id, self.config.deployment_id, self.config.namespace, integer(scope_data["revision"]))
        try:
            scope.check(scope_data)
        except KnowledgeDenied:
            raise Denied() from None
        contour = (state or self.state).contour()
        if (contour.get("enabled") != 1 or contour.get("business_id") != scope.business_id
                or contour.get("deployment_id") != scope.deployment_id or contour.get("namespace") != scope.native_scope
                or contour.get("revision") != scope.revision):
            raise Denied()
        return scope

    def _users(self, data: dict[str, Any], revision: int, state: Any | None = None) -> tuple[str, str]:
        ava_ids = (identifier(data["ownerUserId"]), identifier(data["runtimeUserId"]))
        if ava_ids[0] == ava_ids[1]:
            raise Denied()
        native_ids = []
        for ava_id in ava_ids:
            user = (state or self.state).user(ava_id)
            native_id = self.config.native_id(ava_id)
            if (user is None or user.get("state") != "active" or user.get("revision") != revision
                    or user.get("native_user_id") != native_id):
                raise Denied()
            native_ids.append(native_id)
        return native_ids[0], native_ids[1]

    @staticmethod
    def _document(scope: KnowledgeScope, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or set(value) != {"id", "title", "text", "source_id", "content_hash"}:
            raise Denied()
        if not all(isinstance(value[key], str) and value[key].strip() for key in value):
            raise Denied()
        if (len(value["title"].encode("utf-8")) > MAX_DOCUMENT_TITLE or len(value["text"].encode("utf-8")) > MAX_DOCUMENT_TEXT):
            raise Denied()
        prefix = f"ava:{scope.business_id}:knowledge:"
        suffix = value["id"][len(prefix):] if value["id"].startswith(prefix) else ""
        if (not suffix.isdigit() or len(suffix) > 18 or int(suffix) < 1 or value["source_id"] != suffix
                or not re.fullmatch(r"(?:[0-9a-f]{32}|[0-9a-f]{64})", value["content_hash"])):
            raise Denied()
        return value

    def _session(self):
        if self.session_factory is not None:
            return self.session_factory()
        try:
            from onyx.db.engine.sql_engine import get_session_with_current_tenant
        except ImportError:
            raise Unavailable() from None
        return get_session_with_current_tenant()

    def _write(self, data: dict[str, Any], work: Callable[[Any, KnowledgeScope, str, str], dict[str, Any]]) -> dict[str, Any]:
        """Run one transaction, fencing state immediately before its commit."""
        state = self.state_factory() if self.state_factory is not None else self.state
        try:
            with self._session() as db_session:
                try:
                    scope = self._scope(data, state)
                    owner, runtime = self._users(data, scope.revision, state)
                    result = work(db_session, scope, owner, runtime)
                    # get_session_with_current_tenant only closes.  The durable
                    # revision/user fence must therefore precede an explicit
                    # commit, rather than being assumed from context exit.
                    scope = self._scope(data, state)
                    self._users(data, scope.revision, state)
                    db_session.commit()
                    return result
                except Exception:
                    db_session.rollback()
                    raise
        finally:
            if state is not self.state:
                state.close()

    async def _offloaded_write(self, data: dict[str, Any], work: Callable[[Any, KnowledgeScope, str, str], dict[str, Any]]) -> dict[str, Any]:
        # Indexing is synchronous and may invoke embeddings/blob I/O.  The
        # worker gets a fresh read-only SQLite connection in this thread; the
        # auth sidecar remains independently healthy and responsive.
        if self.state_factory is None:
            return self._write(data, work)
        return await asyncio.to_thread(self._write, data, work)

    async def bootstrap_knowledge(self, data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(data, dict) or set(data) != BOOTSTRAP_FIELDS:
            raise Denied()
        model_configuration_id = integer(data["modelConfigurationId"])
        async with self.lock:
            scope = self._scope(data)
            self._users(data, scope.revision)
            try:
                result = await self._offloaded_write(data, lambda db, current, owner, runtime:
                    self.bootstrap(db, KnowledgeBootstrap(current, owner, runtime, model_configuration_id)))
            except KnowledgeUnavailable:
                raise Unavailable() from None
            except KnowledgeDenied:
                raise Denied() from None
            return result

    async def upsert_knowledge(self, data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(data, dict) or set(data) != UPSERT_FIELDS:
            raise Denied()
        owner_pair, runtime_pair, document_set = (integer(data[key]) for key in ("ownerCcPairId", "runtimeCcPairId", "documentSetId"))
        if owner_pair == runtime_pair:
            raise Denied()
        async with self.lock:
            scope = self._scope(data)
            self._users(data, scope.revision)
            document = self._document(scope, data["document"])
            try:
                result = await self._offloaded_write(data, lambda db, current, owner, runtime:
                    self.ingest(db, scope=current, document=document,
                        owner_cc_pair_id=owner_pair, runtime_cc_pair_id=runtime_pair,
                        document_set_id=document_set, owner_user_id=owner, runtime_user_id=runtime))
            except KnowledgeUnavailable:
                raise Unavailable() from None
            except KnowledgeDenied:
                raise Denied() from None
            return result

    async def delete_knowledge(self, data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(data, dict) or set(data) != DELETE_FIELDS:
            raise Denied()
        owner_pair, runtime_pair, document_set = (integer(data[key]) for key in ("ownerCcPairId", "runtimeCcPairId", "documentSetId"))
        if owner_pair == runtime_pair:
            raise Denied()
        async with self.lock:
            scope = self._scope(data)
            self._users(data, scope.revision)
            document_id = data["documentId"]
            if not isinstance(document_id, str):
                raise Denied()
            prefix = f"ava:{scope.business_id}:knowledge:"
            suffix = document_id[len(prefix):] if document_id.startswith(prefix) else ""
            if not suffix.isdigit() or len(suffix) > 18 or int(suffix) < 1:
                raise Denied()
            try:
                result = await self._offloaded_write(data, lambda db, current, owner, runtime:
                    self.delete(db, scope=current, document_id=document_id,
                        owner_cc_pair_id=owner_pair, runtime_cc_pair_id=runtime_pair,
                        document_set_id=document_set, owner_user_id=owner, runtime_user_id=runtime))
            except KnowledgeUnavailable:
                raise Unavailable() from None
            except KnowledgeDenied:
                raise Denied() from None
            return result
