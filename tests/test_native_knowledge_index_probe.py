"""Synthetic actual-index fixtures: no native/LLM/customer data requests."""
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from onyx_native_index_probe import IndexProbeDenied, probe_index


DOCUMENT = {"native_id": "ava%3A4%3Aknowledge%3A7", "source_id": "7", "content_hash": "a" * 32}


def chunk(**changes):
    values = {"document_id": DOCUMENT["native_id"], "source_type": "ingestion_api", "hidden": False,
              "content": "SYNTHETIC content must not appear in receipts", "metadata": {
                  "business_id": ["4"], "ava_entity_type": ["knowledge"], "ava_source_id": ["7"],
                  "ava_content_hash": [DOCUMENT["content_hash"]]}}
    values.update(changes)
    return SimpleNamespace(**values)


class Index:
    def __init__(self, own, foreign=None):
        self.own, self.foreign, self.calls = own, foreign or [], []

    def random_retrieval(self, *, filters, num_to_retrieve):
        self.calls.append((filters, num_to_retrieve))
        assert filters["acl"] == ["runtime-private-acl"] and filters["document_set"] == ["own-private-docset"]
        assert filters["tenant_id"] == "own-context" and filters["source_type"] == ["ingestion_api"]
        return self.own if filters["tag_key"] == "ava_source_id" else self.foreign


def filters(key, value):
    return {"tag_key": key, "tag_value": value, "acl": ["runtime-private-acl"], "document_set": ["own-private-docset"],
            "tenant_id": "own-context", "source_type": ["ingestion_api"]}


def test_live_default_index_results_are_metadata_only_and_exact_scope_hash():
    index = Index([chunk(), chunk()])
    result = probe_index(index, filters, [DOCUMENT], 4)
    assert result == {"indexReadinessVerified": True, "indexProbeMethod": "default_document_index_random_acl_v1",
                      "indexedDocuments": {"ava:4:knowledge:7": {"onyx_document_id": DOCUMENT["native_id"],
                          "source_id": "7", "content_hash": DOCUMENT["content_hash"]}}}
    assert index.calls[0][0]["tag_value"] == "7" and index.calls[0][1] == 3
    assert index.calls[1][0]["tag_value"] == "5" and index.calls[1][1] == 1
    assert "SYNTHETIC" not in str(result)


@pytest.mark.parametrize("rows", [[], None, [chunk(document_id="ava%3A9%3Aknowledge%3A7")],
    [chunk(hidden=True)], [chunk(source_type="web")], [chunk(metadata={})],
    [chunk(metadata={"business_id": ["9"], "ava_entity_type": ["knowledge"], "ava_source_id": ["7"], "ava_content_hash": ["a" * 32]})],
    [chunk(metadata={"business_id": ["4"], "ava_entity_type": ["knowledge"], "ava_source_id": ["7"], "ava_content_hash": ["b" * 32]})],
    [chunk(metadata={"business_id": ["4", "9"], "ava_entity_type": ["knowledge"], "ava_source_id": ["7"], "ava_content_hash": ["a" * 32]})],
    [chunk(), chunk(document_id="foreign")]])
def test_empty_malformed_foreign_hidden_or_old_index_never_proves_searchability(rows):
    with pytest.raises(IndexProbeDenied): probe_index(Index(rows), filters, [DOCUMENT], 4)


def test_foreign_filter_result_fails_even_when_the_returned_document_is_own():
    with pytest.raises(IndexProbeDenied): probe_index(Index([chunk()], [chunk()]), filters, [DOCUMENT], 4)


def test_empty_corpus_has_no_positive_source_claim_and_still_checks_foreign_visibility():
    index = Index([])
    assert probe_index(index, filters, [], 4)["indexedDocuments"] == {}
    assert len(index.calls) == 2
