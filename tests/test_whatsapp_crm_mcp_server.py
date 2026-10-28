import pytest


CLIENTS_RESPONSE = {
    "success": True,
    "clients": [
        {
            "chatId": "79285348831@c.us",
            "senderName": "Мевлюд",
            "leadStatus": "qualified",
            "lastMessage": "Интересуется услугами и ценами.",
            "lastMessageTime": "2026-05-03 12:00:00",
            "preferredChannel": "whatsapp",
            "detectedLanguage": "ru",
            "tags": "[]",
            "updatedAt": "2026-05-03 12:00:00",
        }
    ],
}

MESSAGES_RESPONSE = {
    "success": True,
    "messages": [
        {
            "role": "user",
            "senderName": "Мевлюд",
            "content": "Какие есть услуги?",
            "timestamp": "2026-05-03 11:59:00",
            "channel": "whatsapp",
        },
        {
            "role": "assistant",
            "senderName": "Bot",
            "content": "У нас есть парикмахерские услуги, маникюр и педикюр.",
            "timestamp": "2026-05-03 12:00:00",
            "channel": "whatsapp",
        },
    ],
}


@pytest.mark.unit
def test_lookup_whatsapp_client_matches_phone_digits(monkeypatch):
    from src.mcp_servers import whatsapp_crm_mcp_server as server

    monkeypatch.setattr(server, "_http_get_json", lambda path: CLIENTS_RESPONSE)

    result = server.lookup_whatsapp_client("+7 (928) 534-88-31", instance_id=1)

    assert result["structured"]["found"] is True
    assert result["structured"]["client"]["chatId"] == "79285348831@c.us"
    assert "Мевлюд" in result["structured"]["spoken"]


@pytest.mark.unit
def test_summarize_whatsapp_conversation_is_voice_safe(monkeypatch):
    from src.mcp_servers import whatsapp_crm_mcp_server as server

    def fake_get(path):
        if path.startswith("/api/clients/"):
            return CLIENTS_RESPONSE
        if path.startswith("/api/messages/"):
            return MESSAGES_RESPONSE
        raise AssertionError(path)

    monkeypatch.setattr(server, "_http_get_json", fake_get)

    result = server.summarize_whatsapp_conversation("79285348831", instance_id=1)

    assert result["structured"]["found"] is True
    assert "raw" not in result["structured"]
    assert result["structured"]["message_count"] == 2
    assert result["structured"]["next_step"] == "ответить конкретным предложением или довести клиента до записи"
    assert result["structured"]["next_step"] in result["structured"]["spoken"]
    assert len(result["structured"]["recent_messages"]) <= 5


@pytest.mark.unit
def test_lookup_whatsapp_client_not_found(monkeypatch):
    from src.mcp_servers import whatsapp_crm_mcp_server as server

    monkeypatch.setattr(server, "_http_get_json", lambda path: {"success": True, "clients": []})

    result = server.lookup_whatsapp_client("79999999999", instance_id=1)

    assert result["structured"]["found"] is False
    assert "не нашел клиента" in result["structured"]["spoken"]
