"""Build-time, pinned-source overlay for Onyx's private web service."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil


SOURCE_FILES = (
    "web/src/lib/utilsSS.ts",
    "web/src/lib/users/svcSS.ts",
    "web/src/lib/auth/svcSS.ts",
)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError("UPSTREAM_WEB_PATCH_CONTEXT_CHANGED")
    return text.replace(old, new, 1)


def _patched_sources(source: dict[str, str]) -> dict[str, str]:
    utils = _replace_once(
        source["web/src/lib/utilsSS.ts"],
        'import { processCookies } from "@/lib/users/svcSS";\n',
        'import { processCookies } from "@/lib/users/svcSS";\n'
        'import { forwardedNativeHeadersSS } from "@/lib/avaSS";\n',
    )
    utils = _replace_once(
        utils,
        '    headers: {\n      ...options?.headers,\n      cookie: cookieString,\n    },',
        '    headers: {\n      ...options?.headers,\n'
        '      ...(await forwardedNativeHeadersSS()),\n'
        '      cookie: cookieString,\n    },',
    )
    users = _replace_once(
        source["web/src/lib/users/svcSS.ts"],
        'import { SERVER_SIDE_ONLY__AUTH_COOKIE_NAME } from "@/lib/constants";\n',
        'import { SERVER_SIDE_ONLY__AUTH_COOKIE_NAME } from "@/lib/constants";\n'
        'import { forwardedNativeHeadersSS } from "@/lib/avaSS";\n',
    )
    users = _replace_once(
        users,
        '      headers: { cookie: cookieString },',
        '      headers: {\n'
        '        ...(await forwardedNativeHeadersSS()),\n'
        '        cookie: cookieString,\n'
        '      },',
    )
    auth = _replace_once(
        source["web/src/lib/auth/svcSS.ts"],
        'import { buildUrl, UrlBuilder } from "@/lib/utilsSS";',
        'import { buildUrl, fetchSS, UrlBuilder } from "@/lib/utilsSS";',
    )
    auth = _replace_once(
        auth,
        '  const res = await fetch(buildUrl("/auth/type"));',
        '  const res = await fetchSS("/auth/type");',
    )
    return {
        "web/src/lib/utilsSS.ts": utils,
        "web/src/lib/users/svcSS.ts": users,
        "web/src/lib/auth/svcSS.ts": auth,
    }


def install(root: Path = Path("/app"), assets: Path = Path("/tmp/ava-extension")) -> None:
    if os.environ.get("AVA_EXTENSION_BUILD") != "1":
        raise ValueError("IMAGE_BUILD_ONLY")
    pinned = json.loads((assets / "upstreams.lock.json").read_text())["onyx"]
    source = {name: (root / name).read_text() for name in SOURCE_FILES}
    for name in SOURCE_FILES:
        if _sha256(root / name) != pinned["files"][name]:
            raise ValueError("INSTALLED_UPSTREAM_WEB_SOURCE_MISMATCH")
    # Render every replacement before changing any upstream file.
    patched = _patched_sources(source)
    helper = assets / "avaSS.ts"
    if not helper.is_file():
        raise ValueError("WEB_OVERLAY_ASSET_MISSING")
    for name, text in patched.items():
        (root / name).write_text(text)
    shutil.copyfile(helper, root / "web/src/lib/avaSS.ts")
    manifest_files = {name: _sha256(root / name) for name in (*SOURCE_FILES, "web/src/lib/avaSS.ts")}
    (root / "AVA_WEB_OVERLAY_MANIFEST.json").write_text(json.dumps({
        "upstream_commit": pinned["commit"],
        "commercial_files_modified": False,
        "changes": manifest_files,
        "native_login_verified": False,
        "production_ready": False,
    }, indent=2) + "\n")


if __name__ == "__main__":
    install()
