import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from api import system  # noqa: E402


def test_project_version_env_override_has_priority(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("AAVA_PROJECT_VERSION", "v9.9.9")
    result = system._detect_project_version(str(tmp_path))
    assert result == {"version": "v9.9.9", "source": "env"}


def test_project_version_prefers_changelog_when_git_describe_is_stale(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("AAVA_PROJECT_VERSION", raising=False)
    (tmp_path / "CHANGELOG.md").write_text(
        "# Changelog\n\n## [Unreleased]\n\n## [6.2.0] - 2026-02-09\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        system.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="v6.1.0-52-gabc123\n"),
    )

    result = system._detect_project_version(str(tmp_path))
    assert result == {"version": "v6.2.0", "source": "changelog"}


def test_project_version_uses_git_when_no_changelog(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("AAVA_PROJECT_VERSION", raising=False)
    (tmp_path / "README.md").write_text("Project version v6.1.0", encoding="utf-8")
    monkeypatch.setattr(
        system.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="v6.2.0\n"),
    )

    result = system._detect_project_version(str(tmp_path))
    assert result == {"version": "v6.2.0", "source": "git"}


def test_project_version_falls_back_to_readme(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("AAVA_PROJECT_VERSION", raising=False)
    (tmp_path / "README.md").write_text("Current release is v6.2.0", encoding="utf-8")
    monkeypatch.setattr(
        system.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout=""),
    )

    result = system._detect_project_version(str(tmp_path))
    assert result == {"version": "v6.2.0", "source": "readme"}
