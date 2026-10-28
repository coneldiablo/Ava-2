from src.config import MCPServerConfig


def test_mcp_server_env_values_are_coerced_to_strings():
    config = MCPServerConfig(
        env={
            "WHATSAPP_CRM_DEFAULT_INSTANCE_ID": 2,
            "WHATSAPP_CRM_TIMEOUT_MS": 5000,
            "EMPTY_VALUE": None,
        }
    )

    assert config.env == {
        "WHATSAPP_CRM_DEFAULT_INSTANCE_ID": "2",
        "WHATSAPP_CRM_TIMEOUT_MS": "5000",
        "EMPTY_VALUE": "",
    }
