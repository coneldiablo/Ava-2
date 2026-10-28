import pytest


@pytest.mark.unit
def test_business_knowledge_answer_is_voice_safe():
    from src.mcp_servers.business_knowledge_mcp_server import answer_from_business_docs

    result = answer_from_business_docs("What time is breakfast?", {})

    assert result["structured"]["spoken"]
    assert "raw_chunks" not in result["structured"]
    assert result["structured"]["citations"]
    assert result["content"][0]["type"] == "text"


@pytest.mark.unit
def test_business_knowledge_answers_russian_breakfast_question():
    from src.mcp_servers.business_knowledge_mcp_server import answer_from_business_docs

    result = answer_from_business_docs("Во сколько завтрак?", {})

    assert "07:00" in result["structured"]["spoken"]
    assert result["structured"]["citations"][0]["chunk_id"] == "breakfast"


@pytest.mark.unit
def test_hotel_demo_booking_lookup_by_extension():
    from src.mcp_servers.hotel_demo_mcp_server import lookup_booking

    result = lookup_booking(phone="6000")

    assert result["structured"]["spoken"]
    assert result["structured"]["found"] is True
    assert result["structured"]["booking"]["booking_id"] == "BK-6000"


@pytest.mark.unit
def test_hotel_demo_booking_lookup_treats_numeric_booking_id_as_extension():
    from src.mcp_servers.hotel_demo_mcp_server import lookup_booking

    result = lookup_booking(booking_id="6000")

    assert result["structured"]["found"] is True
    assert result["structured"]["booking"]["booking_id"] == "BK-6000"


@pytest.mark.unit
def test_hotel_demo_frontdesk_tasks_are_persisted_for_verification(tmp_path, monkeypatch):
    monkeypatch.setenv("AVA_DEMO_DATA_DIR", str(tmp_path))

    from src.mcp_servers.hotel_demo_mcp_server import create_frontdesk_task, list_frontdesk_tasks

    created = create_frontdesk_task({}, "Breakfast question", "Guest asked about breakfast time.")
    listed = list_frontdesk_tasks(limit=1)

    assert created["structured"]["task_id"].startswith("TASK-")
    assert listed["structured"]["tasks"][0]["task_id"] == created["structured"]["task_id"]
    assert (tmp_path / "frontdesk_tasks.jsonl").exists()


@pytest.mark.unit
def test_hotel_demo_handoff_does_not_mutate_telephony():
    from src.mcp_servers.hotel_demo_mcp_server import handoff_to_frontdesk

    result = handoff_to_frontdesk("caller requested a human")

    assert result["structured"]["transfer_required"] is True
    assert result["structured"]["destination_extension"] == "6002"
    assert "dialplan" not in result["structured"]
