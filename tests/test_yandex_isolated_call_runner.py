"""Safety boundaries of the optional isolated host gate; no Asterisk/network."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/yandex-isolated-call-check.py"
spec = importlib.util.spec_from_file_location("isolated_qa", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_offline_default_requires_no_runtime_and_exposes_no_secret():
    result = subprocess.run([sys.executable, str(SCRIPT), "--source", "/nonexistent"],
                            env=dict(os.environ, YANDEX_CLOUD_API_KEY="secret-sentinel"),
                            capture_output=True, text=True, timeout=3)
    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["run"] is False and report["sip_verified"] is False
    assert "secret-sentinel" not in result.stdout + result.stderr


def test_isolated_configs_have_no_production_network_or_crm_endpoints():
    config = runner.build_config()
    assert config["audiosocket"]["port"] != 8090
    assert config["health"]["port"] != 15000
    assert config["asterisk"]["app_name"] != "asterisk-ai-voice-agent"
    assert config["tools"]["qa_durable_receipt"]["url"].startswith("http://127.0.0.1:15998/")
    assert config["tools"]["qa_durable_receipt"]["require_ack"] is True
    assert config["mcp"]["enabled"] is False
    assert not any(name.startswith(("chan_pjsip", "chan_sip", "chan_dahdi", "chan_iax")) for name in runner.MODULES)


def test_asterisk22_ari_bootstrap_dependency_chain_is_present():
    # Missing any of these caused real isolated bootstrap failures on22.8.2:
    # Sorcery config wizard -> websocket client -> ARI -> /asterisk/info route.
    assert {"res_sorcery_config", "res_sorcery_memory", "res_websocket_client", "res_ari", "res_ari_asterisk"} <= set(runner.MODULES)


@pytest.mark.parametrize('model', ['speech-realtime-max-tts-live/latest', 'aliceai-llm-flash'])
def test_generated_config_loads_real_candidate_schema(tmp_path, monkeypatch, model):
    from src.config import load_config
    target = tmp_path / "ai-agent.yaml"
    target.write_text(json.dumps(runner.build_config(model)))
    monkeypatch.setenv("ASTERISK_HOST", "127.0.0.1")
    monkeypatch.setenv("ASTERISK_ARI_PORT", "16888")
    monkeypatch.setenv("ASTERISK_ARI_USERNAME", "qa")
    monkeypatch.setenv("ASTERISK_ARI_PASSWORD", "synthetic-pass")
    config = load_config(str(target))
    assert config.asterisk.port == 16888
    assert config.contexts["yandex_qa"].post_call_tools == ["qa_durable_receipt"]
    assert config.audiosocket.port == 19090


def test_caller_shim_accepts_only_exact_generated_id_and_local_fixture():
    assert 'channel.get("id") == os.environ["QA_ENGINE_CHANNEL_ID"]' in runner.ENTRY
    assert 'startswith("Local/fixture@qa-fixture-")' in runner.ENTRY


def test_private_artifacts_are_owner_only(tmp_path):
    target = tmp_path / "artifact"
    runner.private_write(target, "synthetic")
    assert target.stat().st_mode & 0o777 == 0o600


def test_only_packaged_docs_and_ari_assets_copied(tmp_path):
    origin, target = tmp_path / "package", tmp_path / "private"
    origin.mkdir()
    target.mkdir()
    for name in ("documentation", "rest-api"):
        (origin / name).mkdir()
        (origin / name / "synthetic.xml").write_text("<test/>")
    (origin / "astdb.sqlite3").write_text("must not copy runtime database")
    for name in ("data", "lib"):
        (target / name).mkdir()
    runner.copy_runtime_assets(origin, target)
    assert (target / "data/documentation/synthetic.xml").exists()
    assert (target / "lib/rest-api/synthetic.xml").exists()
    assert not list(target.rglob("astdb.sqlite3"))


def test_synthetic_fixture_resamples_to_actual_asterisk_8k(tmp_path):
    src, dst = tmp_path / "source.wav", tmp_path / "input.wav"
    with wave.open(str(src), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(bytes(48000))
    runner.fixture_8k(src, dst)
    with wave.open(str(dst), "rb") as wav:
        assert (wav.getframerate(), wav.getnframes(), wav.getnchannels(), wav.getsampwidth()) == (8000, 8000, 1, 2)


def test_customer_stereo_fixture_rejected(tmp_path):
    src = tmp_path / "stereo.wav"
    with wave.open(str(src), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(bytes(32000))
    with pytest.raises(ValueError):
        runner.fixture_8k(src, tmp_path / "output.wav")
