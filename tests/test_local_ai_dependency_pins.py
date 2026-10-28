import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SHERPA_REQUIREMENT = re.compile(r"^sherpa-onnx==(?P<version>[^\s]+)$", re.MULTILINE)
SHERPA_BUILD_ARG = re.compile(r"^ARG SHERPA_ONNX_VERSION=(?P<version>[^\s]+)$", re.MULTILINE)
TORCH_REQUIREMENT = re.compile(r"^torch==(?P<version>[^\s]+)$", re.MULTILINE)
TORCH_BUILD_ARG = re.compile(r"^ARG TORCH_VERSION=(?P<version>[^\s]+)$", re.MULTILINE)
KOKORO_REQUIREMENT = re.compile(r"^kokoro==(?P<version>[^\s]+)$", re.MULTILINE)
KOKORO_BUILD_ARG = re.compile(r"^ARG KOKORO_VERSION=(?P<version>[^\s]+)$", re.MULTILINE)
PIP_BUILD_ARG = re.compile(r"^ARG PIP_VERSION=(?P<version>[^\s]+)$", re.MULTILINE)
SETUPTOOLS_BUILD_ARG = re.compile(r"^ARG SETUPTOOLS_VERSION=(?P<version>[^\s]+)$", re.MULTILINE)
WHEEL_BUILD_ARG = re.compile(r"^ARG WHEEL_VERSION=(?P<version>[^\s]+)$", re.MULTILINE)


def _version(pattern: re.Pattern[str], relative_path: str) -> str:
    content = (ROOT / relative_path).read_text(encoding="utf-8")
    match = pattern.search(content)
    assert match is not None, f"Sherpa pin is missing from {relative_path}"
    return match.group("version")


def test_sherpa_version_is_aligned_across_local_ai_build_paths():
    expected = _version(SHERPA_REQUIREMENT, "local_ai_server/requirements.txt")

    for dockerfile in ("local_ai_server/Dockerfile", "local_ai_server/Dockerfile.gpu"):
        content = (ROOT / dockerfile).read_text(encoding="utf-8")
        assert _version(SHERPA_BUILD_ARG, dockerfile) == expected
        assert 'sherpa-onnx==${SHERPA_ONNX_VERSION}' in content


def test_kokoro_and_torch_versions_are_aligned_across_build_paths():
    expected_torch = _version(TORCH_REQUIREMENT, "local_ai_server/requirements.txt")
    expected_kokoro = _version(KOKORO_REQUIREMENT, "local_ai_server/requirements.txt")

    for dockerfile in ("local_ai_server/Dockerfile", "local_ai_server/Dockerfile.gpu"):
        content = (ROOT / dockerfile).read_text(encoding="utf-8")
        assert _version(TORCH_BUILD_ARG, dockerfile) == expected_torch
        assert _version(KOKORO_BUILD_ARG, dockerfile) == expected_kokoro
        assert 'torch==${TORCH_VERSION}' in content
        assert 'kokoro==${KOKORO_VERSION}' in content

    cpu = (ROOT / "local_ai_server/Dockerfile").read_text(encoding="utf-8")
    gpu = (ROOT / "local_ai_server/Dockerfile.gpu").read_text(encoding="utf-8")
    assert "https://download.pytorch.org/whl/cpu" in cpu
    assert "https://download.pytorch.org/whl/cu124" in gpu


def test_container_build_tool_versions_are_security_pinned():
    expected = {
        PIP_BUILD_ARG: "26.2",
        SETUPTOOLS_BUILD_ARG: "83.0.0",
        WHEEL_BUILD_ARG: "0.47.0",
    }

    for dockerfile in ("Dockerfile", "local_ai_server/Dockerfile", "local_ai_server/Dockerfile.gpu"):
        content = (ROOT / dockerfile).read_text(encoding="utf-8")
        for pattern, version in expected.items():
            matches = pattern.findall(content)
            assert matches
            assert set(matches) == {version}
        assert 'pip==${PIP_VERSION}' in content
        assert 'setuptools==${SETUPTOOLS_VERSION}' in content
        assert 'wheel==${WHEEL_VERSION}' in content

    root = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    cpu = (ROOT / "local_ai_server/Dockerfile").read_text(encoding="utf-8")
    gpu = (ROOT / "local_ai_server/Dockerfile.gpu").read_text(encoding="utf-8")
    assert root.count("python -m pip uninstall --yes pip") == 2
    assert cpu.count("python -m pip uninstall --yes pip") == 2
    assert gpu.count("python -m pip uninstall --yes pip") == 1
    assert "apt-get upgrade -y" in root
    assert "apt-get upgrade -y" in cpu
    assert "apt-get upgrade -y" in gpu


def test_melotts_build_does_not_leave_vulnerable_packaging_tools_or_use_cd():
    for dockerfile in ("local_ai_server/Dockerfile", "local_ai_server/Dockerfile.gpu"):
        content = (ROOT / dockerfile).read_text(encoding="utf-8")
        assert "cd /tmp/MeloTTS" not in content
        assert content.count('setuptools==${SETUPTOOLS_VERSION}') >= 2
        assert content.count('wheel==${WHEEL_VERSION}') >= 2


def test_runtime_dependency_security_floors_are_pinned():
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "aiohttp==3.14.3" in requirements
    assert "pydantic_settings==2.14.2" in requirements


def test_local_ai_runtime_images_define_listener_healthcheck():
    for dockerfile in ("local_ai_server/Dockerfile", "local_ai_server/Dockerfile.gpu"):
        content = (ROOT / dockerfile).read_text(encoding="utf-8")
        runtime = content.rsplit("EXPOSE 8765", maxsplit=1)[1]

        assert "HEALTHCHECK --interval=30s" in runtime
        assert "socket.create_connection" in runtime
        assert "LOCAL_WS_PORT" in runtime


def test_trivy_fails_the_build_on_fixable_findings():
    workflow = (ROOT / ".github/workflows/trivy.yml").read_text(encoding="utf-8")
    assert "exit-code: '0'" not in workflow
    assert workflow.count("exit-code: '1'") == 3
