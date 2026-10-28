from types import SimpleNamespace

import pytest

pytest.importorskip("prometheus_client")

from src.engine import Engine


def test_engine_builds_did_mapping_with_plus_and_plain_variants():
    engine = object.__new__(Engine)
    engine.config = SimpleNamespace(
        contexts={
            "hotel_moscow": SimpleNamespace(did="+7 (495) 111-11-11"),
        }
    )

    engine._did_mapping = engine._build_did_mapping()

    assert engine._resolve_context_from_did("+74951111111") == "hotel_moscow"
    assert engine._resolve_context_from_did("74951111111") == "hotel_moscow"
    assert engine._resolve_context_from_did("tel:+7 495 111 11 11") == "hotel_moscow"
