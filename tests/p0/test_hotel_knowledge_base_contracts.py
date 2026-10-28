from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_hotel_knowledge_base_ml_endpoints_are_hotel_scoped():
    source = (ROOT / "whatsapp_crm/src/routes/ml.routes.js").read_text(encoding="utf-8")

    for route in (
        "/hotel-profiles/:id/knowledge-base",
        "/hotel-profiles/:id/knowledge-base/upload",
        "/hotel-profiles/:id/knowledge-base/text",
        "/hotel-profiles/:id/knowledge-base/search",
        "/hotel-profiles/:id/knowledge-base/:fileId",
        "/hotel-profiles/:id/knowledge-base/smoke-test",
    ):
        assert route in source

    assert "resolveHotelKnowledgeScope" in source
    assert "knowledgeBaseInstanceId" in source


def test_sales_brain_rag_answer_uses_hotel_knowledge_base_scope():
    source = (ROOT / "whatsapp_crm/src/services/sales-brain.service.js").read_text(encoding="utf-8")

    assert "HotelProfileService.get(instanceId)" in source
    assert "knowledgeBaseInstanceId" in source
    assert "RAGService.answerFromKnowledge(knowledgeBaseInstanceId" in source
