"""Configuration and identity boundaries for the Neuro + Vertex full agent."""
import pytest
from pydantic import ValidationError

from src.config import NeuroGeminiProviderConfig, _parent_config, neuro_gemini_allowed_models
from src.config.normalization import FULL_AGENT_PROVIDERS, validate_providers


def test_direct_audio_and_independent_vertex_defaults():
    cfg = NeuroGeminiProviderConfig(api_key="fake-neuro-key", proxy_url="http://private-proxy")
    assert cfg.endpoint == "https://speech.neuro.net"
    assert cfg.project_id == "project-70a86530-dd7e-4201-b95"
    assert (cfg.location, cfg.model, cfg.thinking_level) == ("global", "gemini-3.8-flash", "LOW")
    assert cfg.voice_name == "edsel"
    assert cfg.provider_input_sample_rate_hz == cfg.output_sample_rate_hz == 16000
    assert "fake-neuro-key" not in repr(cfg)
    assert "private-proxy" not in repr(cfg)
    assert "neuro_gemini" in FULL_AGENT_PROVIDERS
    validate_providers({"providers": {"neuro_gemini": {"capabilities": ["stt", "llm", "tts"]}}})


@pytest.mark.parametrize("override", [
    {"endpoint": "https://proxy.example"}, {"endpoint": "http://speech.neuro.net"},
    {"endpoint": "https://user:password@speech.neuro.net"}, {"endpoint": "https://speech.neuro.net/v1"},
    {"location": "us-central1"}, {"model": "gemini-unsupported"},
    {"thinking_level": "MINIMAL"}, {"provider_input_sample_rate_hz": 24000},
    {"tool_timeout_seconds": 0}, {"turn_timeout_seconds": 301},
    {"phrase_queue_size": 0}, {"phrase_queue_size": 65},
    {"vad_threshold": 32768}, {"max_tool_calls": 257}, {"vad_silence_ms": 299}, {"vad_silence_ms": 3001},
])
def test_invalid_or_unbounded_runtime_settings_rejected(override):
    with pytest.raises(ValidationError):
        NeuroGeminiProviderConfig(**override)


def test_assignment_also_validates_call_model():
    cfg = NeuroGeminiProviderConfig()
    cfg.model = "gemini-3.7-flash"
    with pytest.raises(ValidationError):
        cfg.model = "chat-model"


def test_environment_identity_injection_and_explicit_enable(monkeypatch):
    for name in ("NEURO_API_KEY", "NEURO_API_ENDPOINT", "NEURO_GEMINI_ENABLED", "GEMINI_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GEMINI_LOCATION", "GEMINI_TEXT_PROXY_URL"):
        monkeypatch.delenv(name, raising=False)
    data = {"providers": {"neuro_gemini": {"api_key": "yaml-key", "enabled": False}}, "llm": {"model": "crm-text-model"}}
    _parent_config._inject_neuro_gemini_config(data)
    assert data["providers"]["neuro_gemini"]["api_key"] is None
    monkeypatch.setenv("NEURO_API_KEY", "env-key")
    monkeypatch.setenv("NEURO_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "adc-project")
    _parent_config._inject_neuro_gemini_config(data)
    assert data["providers"]["neuro_gemini"]["api_key"] == "env-key"
    assert data["providers"]["neuro_gemini"]["enabled"] is True
    assert data["providers"]["neuro_gemini"]["project_id"] == "adc-project"
    monkeypatch.setenv("GEMINI_PROJECT_ID", "vertex-project")
    monkeypatch.setenv("NEURO_GEMINI_ENABLED", "false")
    _parent_config._inject_neuro_gemini_config(data)
    assert data["providers"]["neuro_gemini"]["project_id"] == "vertex-project"
    assert data["providers"]["neuro_gemini"]["enabled"] is False
    assert data["llm"]["model"] == "crm-text-model"


def test_neuro_default_and_rollback_are_configuration_local(monkeypatch):
    monkeypatch.setenv("AVA_VOICE_DEFAULT_PROVIDER", "neuro_gemini")
    data = {"default_provider": "google_live", "providers": {"neuro_gemini": {"enabled": True}, "google_live": {"enabled": True}}}
    _parent_config._inject_yandex_voice_config(data)
    assert data["default_provider"] == "neuro_gemini"
    monkeypatch.setenv("AVA_VOICE_DEFAULT_PROVIDER", "google_live")
    _parent_config._inject_yandex_voice_config(data)
    assert data["default_provider"] == "google_live"


@pytest.mark.parametrize("raw,expected", [("", ("gemini-3.8-flash", "gemini-3.7-flash")),
    ("  ", ("gemini-3.8-flash", "gemini-3.7-flash")), ("gemini-3.7-flash", ("gemini-3.7-flash",)),
    ("unsupported", ()), ("unsupported, gemini-3.8-flash", ("gemini-3.8-flash",))])
def test_effective_catalog_intersection_matches_backend(monkeypatch, raw, expected):
    monkeypatch.setenv("NEURO_GEMINI_MODELS", raw)
    assert neuro_gemini_allowed_models() == expected
