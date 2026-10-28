"""Tests for the pinned Onyx web SSR overlay; no Docker build is required."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("onyx_web_overlay", ROOT / "native_modules/onyx/install_web.py")
overlay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overlay)


SOURCES = {
    "web/src/lib/utilsSS.ts": '''import { processCookies } from "@/lib/users/svcSS";
export async function fetchSS(url: string, options?: RequestInit) {
  const cookieString = processCookies(await cookies());
  const init: RequestInit = {
    credentials: "include",
    cache: "no-store",
    ...options,
    headers: {
      ...options?.headers,
      cookie: cookieString,
    },
  };
  return fetch(buildUrl(url), init);
}
''',
    "web/src/lib/users/svcSS.ts": '''import { SERVER_SIDE_ONLY__AUTH_COOKIE_NAME } from "@/lib/constants";
export async function getCurrentUserSS(): Promise<User | null> {
  const cookieString = processCookies(await cookies());
  const response = await fetch(buildUrl("/me"), {
      credentials: "include",
      next: { revalidate: 0 },
      headers: { cookie: cookieString },
    });
  return response.ok ? response.json() : null;
}
''',
    "web/src/lib/auth/svcSS.ts": '''import { buildUrl, UrlBuilder } from "@/lib/utilsSS";
export async function getAuthTypeMetadataSS(): Promise<AuthTypeMetadata> {
  const res = await fetch(buildUrl("/auth/type"));
  if (!res.ok) throw new Error("Failed to fetch data");
  return res.json();
}
''',
}


def _write_fixture(tmp_path: Path, sources: dict[str, str] = SOURCES):
    app, assets = tmp_path / "app", tmp_path / "assets"
    assets.mkdir()
    for name, text in sources.items():
        destination = app / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)
    lock = {"onyx": {"commit": "a" * 40, "files": {
        name: hashlib.sha256(text.encode()).hexdigest() for name, text in sources.items()
    }}}
    (assets / "upstreams.lock.json").write_text(json.dumps(lock))
    (assets / "avaSS.ts").write_text((ROOT / "native_modules/onyx/avaSS.ts").read_text())
    return app, assets


def test_overlay_forwards_only_gateway_injected_headers_and_preserves_missing_identity():
    helper = (ROOT / "native_modules/onyx/avaSS.ts").read_text()
    assert '"x-ava-native-peer"' in helper
    assert '"x-ava-native-binding"' in helper
    assert "NATIVE_SSR_HEADERS" in helper
    assert "return forwarded" in helper
    assert "fallback" not in helper.lower()
    assert "default" not in helper.lower()
    assert "cookie" not in helper.lower()


def test_overlay_is_build_only_and_patches_all_authenticated_ssr_reads(monkeypatch, tmp_path):
    app, assets = _write_fixture(tmp_path)
    monkeypatch.setenv("AVA_EXTENSION_BUILD", "1")
    overlay.install(app, assets)
    utils = (app / "web/src/lib/utilsSS.ts").read_text()
    users = (app / "web/src/lib/users/svcSS.ts").read_text()
    auth = (app / "web/src/lib/auth/svcSS.ts").read_text()
    assert "...(await forwardedNativeHeadersSS())," in utils
    assert "...(await forwardedNativeHeadersSS())," in users
    assert 'const res = await fetchSS("/auth/type");' in auth
    assert 'fetch(buildUrl("/auth/type"))' not in auth
    manifest = json.loads((app / "AVA_WEB_OVERLAY_MANIFEST.json").read_text())
    assert manifest["upstream_commit"] == "a" * 40
    assert manifest["native_login_verified"] is False
    assert manifest["production_ready"] is False


def test_overlay_rejects_unpinned_source_without_partial_write(monkeypatch, tmp_path):
    app, assets = _write_fixture(tmp_path)
    monkeypatch.setenv("AVA_EXTENSION_BUILD", "1")
    target = app / "web/src/lib/users/svcSS.ts"
    original = target.read_text()
    target.write_text(original + "// drift\n")
    before = (app / "web/src/lib/utilsSS.ts").read_text()
    with pytest.raises(ValueError, match="INSTALLED_UPSTREAM_WEB_SOURCE_MISMATCH"):
        overlay.install(app, assets)
    assert (app / "web/src/lib/utilsSS.ts").read_text() == before


def test_overlay_is_single_use_and_second_run_fails_closed(monkeypatch, tmp_path):
    app, assets = _write_fixture(tmp_path)
    monkeypatch.setenv("AVA_EXTENSION_BUILD", "1")
    overlay.install(app, assets)
    before = (app / "web/src/lib/utilsSS.ts").read_text()
    with pytest.raises(ValueError, match="INSTALLED_UPSTREAM_WEB_SOURCE_MISMATCH"):
        overlay.install(app, assets)
    assert (app / "web/src/lib/utilsSS.ts").read_text() == before


def test_overlay_requires_explicit_build_context(monkeypatch, tmp_path):
    app, assets = _write_fixture(tmp_path)
    monkeypatch.delenv("AVA_EXTENSION_BUILD", raising=False)
    with pytest.raises(ValueError, match="IMAGE_BUILD_ONLY"):
        overlay.install(app, assets)


def test_lock_pins_the_exact_upstream_web_sources():
    lock = json.loads((ROOT / "native_modules/upstreams.lock.json").read_text())["onyx"]["files"]
    assert lock["web/src/lib/utilsSS.ts"] == "a59e2e7091bde510733cd91df1d4fc4a7e1a56ef36796afadeedfb60bb8077c5"
    assert lock["web/src/lib/users/svcSS.ts"] == "e1d06c0ed252a3e21b605fd25ff69d22ba711a82632b4c60badfab814651a818"
    assert lock["web/src/lib/auth/svcSS.ts"] == "05f94d4a4c91a8b2addf2329cc59844c927524eb0a6416a8007e2bcb431165f4"
