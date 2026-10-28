#!/usr/bin/env python3
"""Install AVA's deliberately small Community private-knowledge read extension.

The target is checksum-pinned because this is an upstream source transformation:
an upgraded Onyx source must be reviewed rather than receiving a best-effort patch.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile


EXPECTED_SOURCE_SHA256 = "fa036d02d0bf19f0919436e91d5aa2b414b2983defe33ac008afe21bb29de4d7"
MARKER = "# AVA_PRIVATE_KNOWLEDGE_READ_EXTENSION_V1"


IMPORT_NEEDLE = "from collections.abc import Sequence\n"
IMPORT_REPLACEMENT = """from collections.abc import Sequence
import os
import re
"""
SQLALCHEMY_NEEDLE = "from sqlalchemy import Select, and_, delete, func, or_, select\n"
SQLALCHEMY_REPLACEMENT = (
    "from sqlalchemy import Select, and_, delete, false, func, or_, select\n"
)
MODEL_NEEDLE = """    DocumentSet__ConnectorCredentialPair,
    DocumentSet__UserGroup,
"""
MODEL_REPLACEMENT = """    DocumentSet__ConnectorCredentialPair,
    DocumentSet__User,
    DocumentSet__UserGroup,
"""
FUNCTION_NEEDLE = """def _add_user_filters(stmt: Select, user: User, get_editable: bool = True) -> Select:
    # MANAGE → always return all
"""
FUNCTION_REPLACEMENT = """# AVA_PRIVATE_KNOWLEDGE_READ_EXTENSION_V1
_AVA_DEPLOYMENT_NAMESPACE_RE = re.compile(r"ava_[0-9a-f]{32}\\Z")


def _ava_private_knowledge_document_set_name() -> str | None:
    \"\"\"Return only this deployment's canonical private knowledge set name.\"\"\"
    namespace = os.environ.get("AVA_DEPLOYMENT_NAMESPACE", "")
    if not _AVA_DEPLOYMENT_NAMESPACE_RE.fullmatch(namespace):
        return None
    return f"ava-native-{namespace.removeprefix('ava_')}-knowledge"


def _ava_private_knowledge_read_clause(user: User | None):
    \"\"\"Permit direct read only for the canonical AVA private knowledge set.\"\"\"
    document_set_name = _ava_private_knowledge_document_set_name()
    if user is None or getattr(user, "is_anonymous", False) or document_set_name is None:
        return false()
    directly_assigned = select(DocumentSet__User.document_set_id).where(
        DocumentSet__User.user_id == user.id
    )
    return and_(
        DocumentSetDBModel.is_public.is_(False),
        DocumentSetDBModel.name == document_set_name,
        or_(
            DocumentSetDBModel.user_id == user.id,
            DocumentSetDBModel.id.in_(directly_assigned),
        ),
    )


def _add_user_filters(stmt: Select, user: User | None, get_editable: bool = True) -> Select:
    # Anonymous requests have no Community identity and must not receive a set.
    if user is None:
        return stmt.where(false())
    # MANAGE → always return all
"""
RETURN_NEEDLE = """    return stmt.where(
        or_(
            DocumentSetDBModel.is_public.is_(True),
            DocumentSetDBModel.id.in_(accessible_via_group),
        )
    )
"""
RETURN_REPLACEMENT = """    return stmt.where(
        or_(
            DocumentSetDBModel.is_public.is_(True),
            DocumentSetDBModel.id.in_(accessible_via_group),
            _ava_private_knowledge_read_clause(user),
        )
    )
"""


def _replace_once(source: str, needle: str, replacement: str, label: str) -> str:
    if source.count(needle) != 1:
        raise ValueError(f"unexpected pinned source shape for {label}")
    return source.replace(needle, replacement, 1)


def install(target: Path) -> None:
    source = target.read_bytes()
    actual_sha256 = hashlib.sha256(source).hexdigest()
    if actual_sha256 != EXPECTED_SOURCE_SHA256:
        raise ValueError(
            "refusing to patch unreviewed Onyx document_set.py: "
            f"expected {EXPECTED_SOURCE_SHA256}, got {actual_sha256}"
        )
    text = source.decode("utf-8")
    if MARKER in text:
        raise ValueError("refusing to patch an already modified Onyx source")

    text = _replace_once(text, IMPORT_NEEDLE, IMPORT_REPLACEMENT, "stdlib imports")
    text = _replace_once(text, SQLALCHEMY_NEEDLE, SQLALCHEMY_REPLACEMENT, "sqlalchemy imports")
    text = _replace_once(text, MODEL_NEEDLE, MODEL_REPLACEMENT, "model imports")
    text = _replace_once(text, FUNCTION_NEEDLE, FUNCTION_REPLACEMENT, "read filter entry")
    text = _replace_once(text, RETURN_NEEDLE, RETURN_REPLACEMENT, "read filter return")

    mode = stat.S_IMODE(target.stat().st_mode)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=target.parent, delete=False
    ) as replacement:
        replacement.write(text)
        replacement.flush()
        os.fsync(replacement.fileno())
        replacement_path = Path(replacement.name)
    replacement_path.chmod(mode)
    replacement_path.replace(target)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, required=True)
    args = parser.parse_args()
    try:
        install(args.target)
    except (OSError, UnicodeDecodeError, ValueError) as error:
        print(f"knowledge ACL install failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
