"""Worker-only bootstrap for one isolated Community Onyx knowledge contour.

This deliberately uses the pinned Community ORM surface rather than admin HTTP
routes.  It creates no API key, no public resource, and no Enterprise import.
The caller owns the worker lease and must commit only after it has persisted the
returned opaque IDs into AVA's deployment-scoped binding tables.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from .knowledge import KnowledgeDenied, KnowledgeScope, KnowledgeUnavailable


@dataclass(frozen=True)
class KnowledgeBootstrap:
    scope: KnowledgeScope
    owner_user_id: str
    runtime_user_id: str
    model_configuration_id: int

    def validate(self) -> tuple[UUID, UUID]:
        if type(self.model_configuration_id) is not int or self.model_configuration_id < 1:
            raise KnowledgeDenied()
        try:
            owner, runtime = UUID(self.owner_user_id), UUID(self.runtime_user_id)
        except (TypeError, ValueError):
            raise KnowledgeDenied() from None
        if str(owner) != self.owner_user_id or str(runtime) != self.runtime_user_id or owner == runtime:
            raise KnowledgeDenied()
        return owner, runtime

    @property
    def suffix(self) -> str:
        # deployment IDs are canonicalised by KnowledgeScope's trusted caller;
        # keep the names stable across retries and never use a hotel display name.
        try:
            value = UUID(self.scope.deployment_id)
        except (TypeError, ValueError):
            raise KnowledgeDenied() from None
        if str(value) != self.scope.deployment_id:
            raise KnowledgeDenied()
        return value.hex


def _names(bootstrap: KnowledgeBootstrap) -> dict[str, str]:
    suffix = bootstrap.suffix
    return {
        'credential': f'ava-native-{suffix}-ingestion-credential',
        'owner_credential': f'ava-native-{suffix}-owner-ingestion-credential',
        'runtime_credential': f'ava-native-{suffix}-runtime-ingestion-credential',
        'owner_pair': f'ava-native-{suffix}-owner-ingestion',
        'runtime_pair': f'ava-native-{suffix}-runtime-ingestion',
        'document_set': f'ava-native-{suffix}-knowledge',
        'persona': 'Помощник отеля AVA',
    }


def _only(rows: list[Any]) -> Any | None:
    if len(rows) > 1:
        raise KnowledgeDenied()
    return rows[0] if rows else None


def _rows(db_session: Any, model: Any, field: Any, value: Any) -> list[Any]:
    return list(db_session.query(model).filter(field == value).all())


def _require_active_users(db_session: Any, models: Any, owner: UUID, runtime: UUID) -> None:
    users = [db_session.get(models.User, value) for value in (owner, runtime)]
    if any(user is None or user.is_active is not True for user in users):
        raise KnowledgeDenied()


def _reconcile_exact_members(db_session: Any, relation: Any, left_field: Any, left_id: int,
                             right_field: Any, wanted: set[UUID], *, make: Any) -> None:
    existing = _rows(db_session, relation, left_field, left_id)
    actual = {row.user_id for row in existing}
    if actual - wanted:
        # A collision must not silently take over someone else's resource.
        raise KnowledgeDenied()
    for user_id in wanted - actual:
        db_session.add(make(user_id))


def bootstrap_private_knowledge(db_session: Any, bootstrap: KnowledgeBootstrap) -> dict[str, int | str]:
    """Create or reconcile the isolated Community resources for one deployment.

    Community's private document-set hook is a no-op, so one private CC pair
    cannot safely grant both users document access.  We instead create two
    private pairs, each owned by one admitted user, and attach both to the
    same document set.  The worker must index every canonical document through
    both pairs; this module returns both IDs for that purpose.
    """
    owner, runtime = bootstrap.validate()
    names = _names(bootstrap)
    try:
        from onyx.configs.constants import DocumentSource
        from onyx.connectors.models import InputType
        from onyx.db.enums import AccessType, ConnectorCredentialPairStatus, PersonaSharePermission
        from onyx.db.models import (
            Connector, ConnectorCredentialPair, Credential, DocumentSet, DocumentSet__ConnectorCredentialPair,
            DocumentSet__User, Persona, Persona__DocumentSet, Persona__Tool, Persona__User, User,
        )
        from onyx.db.tools import get_builtin_tool
        from onyx.tools.tool_implementations.search.search_tool import SearchTool
    except ImportError:
        raise KnowledgeUnavailable() from None

    class Models:
        pass
    models = Models()
    for name, value in locals().copy().items():
        if name in {'Connector', 'ConnectorCredentialPair', 'Credential', 'DocumentSet', 'DocumentSet__ConnectorCredentialPair',
                    'DocumentSet__User', 'Persona', 'Persona__DocumentSet', 'Persona__Tool', 'Persona__User', 'User'}:
            setattr(models, name, value)
    _require_active_users(db_session, models, owner, runtime)

    connector = db_session.get(Connector, 0)
    if (connector is None or connector.source != DocumentSource.INGESTION_API
            or connector.input_type != InputType.LOAD_STATE):
        raise KnowledgeUnavailable()

    pairs = []
    for label, user in (('owner', owner), ('runtime', runtime)):
        credential = _only(_rows(db_session, Credential, Credential.name, names[f'{label}_credential']))
        if credential is None:
            credential = Credential(name=names[f'{label}_credential'], source=DocumentSource.INGESTION_API,
                                    credential_json=None, user_id=user, admin_public=False, curator_public=False)
            db_session.add(credential); db_session.flush()
        elif (credential.source != DocumentSource.INGESTION_API or credential.user_id != user
              or credential.admin_public or credential.curator_public):
            raise KnowledgeDenied()
        pair = _only(_rows(db_session, ConnectorCredentialPair, ConnectorCredentialPair.name, names[f'{label}_pair']))
        if pair is None:
            pair = ConnectorCredentialPair(name=names[f'{label}_pair'], status=ConnectorCredentialPairStatus.ACTIVE,
                                           connector_id=connector.id, credential_id=credential.id,
                                           access_type=AccessType.PRIVATE, creator_id=user)
            db_session.add(pair); db_session.flush()
        elif (pair.connector_id != connector.id or pair.credential_id != credential.id
              or pair.access_type != AccessType.PRIVATE or pair.creator_id != user):
            raise KnowledgeDenied()
        pairs.append(pair)

    document_set = _only(_rows(db_session, DocumentSet, DocumentSet.name, names['document_set']))
    if document_set is None:
        document_set = DocumentSet(name=names['document_set'], description='AVA isolated knowledge', user_id=owner,
                                   is_public=False, is_up_to_date=False)
        db_session.add(document_set)
        db_session.flush()
    elif document_set.user_id != owner or document_set.is_public:
        raise KnowledgeDenied()
    ds_pairs = _rows(db_session, DocumentSet__ConnectorCredentialPair,
                     DocumentSet__ConnectorCredentialPair.document_set_id, document_set.id)
    if any(row.connector_credential_pair_id not in {pair.id for pair in pairs} or row.is_current is not True for row in ds_pairs):
        raise KnowledgeDenied()
    actual_pairs = {row.connector_credential_pair_id for row in ds_pairs}
    for pair in pairs:
        if pair.id not in actual_pairs:
            db_session.add(DocumentSet__ConnectorCredentialPair(document_set_id=document_set.id,
                           connector_credential_pair_id=pair.id, is_current=True))
    _reconcile_exact_members(db_session, DocumentSet__User, DocumentSet__User.document_set_id, document_set.id,
                             DocumentSet__User.user_id, {owner, runtime},
                             make=lambda user_id: DocumentSet__User(document_set_id=document_set.id, user_id=user_id))

    search_tool = get_builtin_tool(db_session, SearchTool)
    if search_tool is None or search_tool.enabled is not True:
        raise KnowledgeUnavailable()
    persona = _only(_rows(db_session, Persona, Persona.name, names['persona']))
    legacy_persona = _only(_rows(db_session, Persona, Persona.name, f'ava-native-{bootstrap.suffix}-sales'))
    if persona is not None and legacy_persona is not None and persona.id != legacy_persona.id:
        raise KnowledgeDenied()
    if persona is None:
        persona = legacy_persona
    if persona is None:
        persona = Persona(user_id=owner, name=names['persona'], description='Ответы по базе знаний вашего отеля',
                          default_model_configuration_id=bootstrap.model_configuration_id, builtin_persona=False,
                          is_featured=False, is_listed=True, deleted=False, is_public=False,
                          system_prompt=None, task_prompt=None, replace_base_system_prompt=False, datetime_aware=True)
        db_session.add(persona)
        db_session.flush()
    elif (persona.user_id != owner or persona.deleted or persona.is_public
          or persona.default_model_configuration_id != bootstrap.model_configuration_id):
        raise KnowledgeDenied()
    # Community direct shares are effective only for listed agents. Listing
    # does not make this private agent public or grant access to other users.
    persona.is_listed = True
    persona.name = names['persona']
    persona.description = 'Ответы по базе знаний вашего отеля'
    persona_sets = _rows(db_session, Persona__DocumentSet, Persona__DocumentSet.persona_id, persona.id)
    if any(row.document_set_id != document_set.id for row in persona_sets):
        raise KnowledgeDenied()
    if not persona_sets:
        db_session.add(Persona__DocumentSet(persona_id=persona.id, document_set_id=document_set.id))
    persona_tools = _rows(db_session, Persona__Tool, Persona__Tool.persona_id, persona.id)
    if any(row.tool_id != search_tool.id for row in persona_tools):
        raise KnowledgeDenied()
    if not persona_tools:
        db_session.add(Persona__Tool(persona_id=persona.id, tool_id=search_tool.id))
    _reconcile_exact_members(db_session, Persona__User, Persona__User.persona_id, persona.id,
                             Persona__User.user_id, {runtime},
                             make=lambda user_id: Persona__User(persona_id=persona.id, user_id=user_id,
                                                                   permission=PersonaSharePermission.VIEWER))
    db_session.flush()
    return {'owner_cc_pair_id': pairs[0].id, 'runtime_cc_pair_id': pairs[1].id,
            'document_set_id': document_set.id, 'document_set_name': document_set.name,
            'persona_id': persona.id, 'search_tool_id': search_tool.id}
