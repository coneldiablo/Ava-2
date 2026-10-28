#!/usr/bin/env python3
"""Install the bounded Community SearchTool availability extension.

The pinned upstream check intentionally ignores connector 0.  AVA's private
ingestion pairs are admitted only when this deployment has a real persisted
ingestion document association; foreign pairs and empty bootstraps do not make
SearchTool available.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
import tempfile
from urllib.parse import quote


EXPECTED_SOURCE_SHA256 = "eff9b1a375407ed2ef5dc03e43e29a236b600ca047326422374e6f9b4f981398"
MARKER = "# AVA_INGESTION_SEARCH_AVAILABILITY_V1"
IMPORT_NEEDLE = "from datetime import datetime, timezone\n"
IMPORT_REPLACEMENT = "from datetime import datetime, timezone\nimport os\nimport re\nfrom urllib.parse import quote\n"
ENUM_NEEDLE = "from onyx.db.enums import IndexingMode\n"
ENUM_REPLACEMENT = "from onyx.db.enums import AccessType, ConnectorCredentialPairStatus, IndexingMode\n"
MODEL_NEEDLE = "    ConnectorCredentialPair,\n    FederatedConnector,\n"
MODEL_REPLACEMENT = "    ConnectorCredentialPair,\n    Document,\n    DocumentByConnectorCredentialPair,\n    FederatedConnector,\n"
FUNCTION_NEEDLE = """def check_connectors_exist(db_session: Session) -> bool:
    # Connector 0 is created on server startup as a default for ingestion
    # it will always exist and we don't need to count it for this
    stmt = select(exists(Connector).where(Connector.id > 0))
    result = db_session.execute(stmt)
    return result.scalar() or False
"""
FUNCTION_REPLACEMENT = """# AVA_INGESTION_SEARCH_AVAILABILITY_V1
def _ava_ingestion_documents_exist(db_session: Session) -> bool:
    namespace = os.environ.get("AVA_DEPLOYMENT_NAMESPACE", "")
    if not re.fullmatch(r"ava_[0-9a-f]{32}\\Z", namespace):
        return False
    business_id = os.environ.get("AVA_BUSINESS_ID", "")
    if not re.fullmatch(r"[1-9][0-9]*\\Z", business_id):
        return False
    suffix = namespace.removeprefix("ava_")
    pair_names = (f"ava-native-{suffix}-owner-ingestion", f"ava-native-{suffix}-runtime-ingestion")
    from onyx.db.enums import AccessType
    stmt = select(exists().where(
        Document.id == DocumentByConnectorCredentialPair.id,
        Document.id.startswith(quote(f"ava:{business_id}:knowledge:", safe=""), autoescape=True),
        Document.from_ingestion_api.is_(True),
        DocumentByConnectorCredentialPair.connector_id == ConnectorCredentialPair.connector_id,
        DocumentByConnectorCredentialPair.credential_id == ConnectorCredentialPair.credential_id,
        ConnectorCredentialPair.name.in_(pair_names),
        ConnectorCredentialPair.access_type == AccessType.PRIVATE,
        ConnectorCredentialPair.status == ConnectorCredentialPairStatus.ACTIVE,
        Connector.source == DocumentSource.INGESTION_API,
    ).where(Connector.id == ConnectorCredentialPair.connector_id))
    return bool(db_session.execute(stmt).scalar())


def check_connectors_exist(db_session: Session) -> bool:
    # Preserve normal Community connector behavior, then admit only a real
    # AVA document tied to this deployment's private ingestion pair.
    stmt = select(exists(Connector).where(Connector.id > 0))
    result = db_session.execute(stmt)
    return bool(result.scalar() or _ava_ingestion_documents_exist(db_session))
"""


def replace_once(source: str, needle: str, replacement: str, label: str) -> str:
    if source.count(needle) != 1:
        raise ValueError(f"unexpected pinned source shape for {label}")
    return source.replace(needle, replacement, 1)


def install(target: Path) -> None:
    source = target.read_bytes()
    if hashlib.sha256(source).hexdigest() != EXPECTED_SOURCE_SHA256:
        raise ValueError("refusing to patch unreviewed pinned connector.py")
    text = source.decode("utf-8")
    if MARKER in text:
        raise ValueError("refusing to patch an already modified connector.py")
    text = replace_once(text, IMPORT_NEEDLE, IMPORT_REPLACEMENT, "imports")
    text = replace_once(text, ENUM_NEEDLE, ENUM_REPLACEMENT, "enums")
    text = replace_once(text, MODEL_NEEDLE, MODEL_REPLACEMENT, "models")
    text = replace_once(text, FUNCTION_NEEDLE, FUNCTION_REPLACEMENT, "connector availability")
    mode = stat.S_IMODE(target.stat().st_mode)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, delete=False) as handle:
        handle.write(text); handle.flush(); os.fsync(handle.fileno()); replacement = Path(handle.name)
    replacement.chmod(mode); replacement.replace(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--target", type=Path, required=True)
    try:
        install(parser.parse_args().target)
    except (OSError, UnicodeDecodeError, ValueError):
        raise SystemExit(1) from None
