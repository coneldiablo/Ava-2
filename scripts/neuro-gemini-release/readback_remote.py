#!/usr/bin/env python3
"""Read back installed source, retained production overlays and HTTPS assets."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
from urllib.request import Request, urlopen


def main(root):
    spec = importlib.util.spec_from_file_location("release_operator", root / "tooling/release_operator.py")
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)
    prepared = release.load(root)
    installed = release.verify(root, active=(root / "activated.private.json").is_file())
    before = json.loads((root / "production-source-before.json").read_text())
    engine = json.loads((root / "engine-0882143-b4/manifest.json").read_text())
    crm = json.loads((root / "crm-0882143-b4/manifest.json").read_text())
    source = {}
    for role, name in release.NAMES.items():
        manifest = engine if role == "engine" else crm["services"][role]
        expected = {**before[name]["sourceHashes"], **manifest["files"]}
        if role == "engine":
            code = 'import json,pathlib,hashlib;names=json.load(__import__("sys").stdin);print(json.dumps({n:hashlib.sha256(pathlib.Path("/app",n).read_bytes()).hexdigest() if pathlib.Path("/app",n).is_file() else None for n in names}))'
        else:
            code = 'const fs=require("fs"),c=require("crypto"),out={};for(const n of JSON.parse(fs.readFileSync(0,"utf8"))){let p="/app/"+n;out[n]=fs.existsSync(p)?c.createHash("sha256").update(fs.readFileSync(p)).digest("hex"):null;}console.log(JSON.stringify(out));'
        interpreter, flag = ("python", "-c") if role == "engine" else ("node", "-e")
        actual = json.loads(release.run(["docker", "exec", "-i", name, interpreter, flag, code], input=json.dumps(list(expected))))
        if actual != expected:
            raise RuntimeError("INSTALLED_SOURCE_MISMATCH_" + role.upper())
        source[role] = {"verifiedFiles": len(expected), "changedFiles": len(manifest["files"]),
                        "unchangedProductionFilesPreserved": len(set(before[name]["sourceHashes"]) - set(manifest["files"]))}

    files = {key.removeprefix("frontend/dist/"): value for key, value in crm["services"]["crm"]["files"].items()
             if key.startswith("frontend/dist/")}
    base = "https://wh.meludtech.tech/"
    def fetch(path):
        if not re.fullmatch(r"[A-Za-z0-9_./@-]+", path) or ".." in path.split("/"):
            raise RuntimeError("INVALID_ASSET_PATH")
        with urlopen(Request(base + path, headers={"Cache-Control": "no-cache"}), timeout=20) as response:
            value = response.read(16 * 1024 * 1024)
            if response.status != 200 or hashlib.sha256(value).hexdigest() != files[path]:
                raise RuntimeError("PUBLIC_ASSET_MISMATCH")
        return path
    with ThreadPoolExecutor(max_workers=4) as pool:
        published = list(pool.map(fetch, files))
    routes = []
    for path in ("", "today", "integrations", "assistant-builder"):
        with urlopen(Request(base + path, headers={"Cache-Control": "no-cache"}), timeout=20) as response:
            if response.status != 200 or hashlib.sha256(response.read()).hexdigest() != files["index.html"]:
                raise RuntimeError("PUBLIC_ROUTE_CHANGED")
        routes.append("/" + path)
    receipt = {"pass": True, **installed, "source": source, "publishedAssets": len(published), "routes": routes,
               "authenticatedBrowserAcceptance": False, "carrierCallAcceptance": False}
    release.private_json(root / "production-readback.json", receipt)
    print(json.dumps(receipt))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    main(parser.parse_args().root)
