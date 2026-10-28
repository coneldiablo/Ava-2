import pytest

from src.config import AppConfig
from src.pipelines.orchestrator import PipelineOrchestrator


def _build_app_config_with_one_invalid_pipeline() -> AppConfig:
    providers = {"openai": {"api_key": "test-key"}}
    pipelines = {
        "openai_stack": {
            "stt": "openai_stt",
            "llm": "openai_llm",
            "tts": "openai_tts",
        },
        # Missing GOOGLE_API_KEY by design; should be treated as invalid rather than
        # silently resolved to placeholder adapters.
        "google_stack": {
            "stt": "google_stt",
            "llm": "google_llm",
            "tts": "google_tts",
        },
    }
    return AppConfig(
        default_provider="openai",
        providers=providers,
        asterisk={"host": "127.0.0.1", "username": "ari", "password": "secret"},
        llm={"initial_greeting": "hi", "prompt": "prompt"},
        audio_transport="audiosocket",
        downstream_mode="stream",
        pipelines=pipelines,
        active_pipeline="openai_stack",
    )


@pytest.mark.asyncio
async def test_orchestrator_skips_invalid_pipelines_and_keeps_valid_ones(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)

    app_config = _build_app_config_with_one_invalid_pipeline()
    orchestrator = PipelineOrchestrator(app_config)
    await orchestrator.start()

    assert orchestrator.started
    assert "google_stack" in orchestrator._invalid_pipelines

    resolution = orchestrator.get_pipeline("call-1", "google_stack")
    assert resolution is not None
    assert resolution.pipeline_name == "openai_stack"

