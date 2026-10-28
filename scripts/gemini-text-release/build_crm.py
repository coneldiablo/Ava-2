#!/usr/bin/env python3
"""Build exact CRM/worker overlays and an isolated locked Gemini auth dependency.

No Docker, npm, SSH or app is executed here. All code and package bytes are Git
blobs. The Docker recipes preserve base node_modules and add one new package
entry pointing into a private dependency tree; unrelated dependencies stay intact.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re

spec = importlib.util.spec_from_file_location("bundle", Path(__file__).parents[1] / "ava-registration-release/build_bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
AUTH_NAME, AUTH_VERSION = "google-auth-library", "10.5.0"


def runtime_paths(repo, base, candidate):
    records = bundle.git(repo, "diff", "--name-status", "--no-renames", "-z", base, candidate).split(b"\0")
    selected = []
    for index in range(0, len(records) - 1, 2):
        status, raw_path = records[index:index + 2]
        path = raw_path.decode()
        bundle.relative(path)
        if not path.startswith("whatsapp_crm/"):
            continue
        rel = path[len("whatsapp_crm/"):]
        if rel.startswith("src/") or rel in ("server.js", "provisioning-worker.js"):
            bundle.require(rel.endswith(".js") and status in (b"A", b"M"), "RUNTIME_DELETION_OR_TYPE_CHANGE")
            selected.append(rel)
        elif rel in ("package.json", "package-lock.json"):
            bundle.require(status == b"M", "DEPENDENCY_TYPE_CHANGE")
        elif rel.startswith("frontend/"):
            bundle.require(PurePosixPath(rel).name not in ("package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"), "FRONTEND_DEPENDENCY_CHANGE")
            bundle.require(status in (b"A", b"M", b"D"), "FRONTEND_TYPE_CHANGE")
        else:
            bundle.require(rel.startswith(("tests/", "docs/", "scripts/", ".github/")) or rel.endswith(".md"), "UNSUPPORTED_RUNTIME_INPUT")
    bundle.require(selected, "EMPTY_RUNTIME_OVERLAY")
    return sorted(selected)


def dependency_lock(repo, base, candidate):
    old_package = json.loads(bundle.blob(repo, base, "whatsapp_crm/package.json"))
    package = json.loads(bundle.blob(repo, candidate, "whatsapp_crm/package.json"))
    clean = copy.deepcopy(package)
    bundle.require(clean.get("dependencies", {}).pop(AUTH_NAME, None) == AUTH_VERSION, "AUTH_DEPENDENCY_NOT_PINNED")
    bundle.require(clean == old_package and AUTH_NAME not in old_package.get("dependencies", {}), "UNREVIEWED_DEPENDENCY_CHANGE")
    old_lock = json.loads(bundle.blob(repo, base, "whatsapp_crm/package-lock.json"))
    lock = json.loads(bundle.blob(repo, candidate, "whatsapp_crm/package-lock.json"))
    bundle.require(lock.get("lockfileVersion") == 3, "LOCK_VERSION_UNSUPPORTED")
    old_packages, packages = old_lock["packages"], lock["packages"]
    for path, value in old_packages.items():
        current = copy.deepcopy(packages.get(path))
        if path == "":
            bundle.require(current["dependencies"].pop(AUTH_NAME, None) == AUTH_VERSION, "LOCK_ROOT_AUTH_MISMATCH")
        bundle.require(current == value, "EXISTING_DEPENDENCY_LOCK_CHANGED:" + path)
    root_name = "node_modules/" + AUTH_NAME
    bundle.require(packages.get(root_name, {}).get("version") == AUTH_VERSION, "AUTH_LOCK_VERSION_MISMATCH")
    selected, pending = {}, [root_name]
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        value = packages[name]
        bundle.relative(name)
        bundle.require(value.get("resolved", "").startswith("https://registry.npmjs.org/") and re.fullmatch(r"sha512-[A-Za-z0-9+/=]+", value.get("integrity", "")), "UNPINNED_DEPENDENCY:" + name)
        bundle.require(not value.get("link") and not value.get("inBundle"), "DEPENDENCY_LINK_FORBIDDEN")
        selected[name] = copy.deepcopy(value)
        dependencies = {**value.get("dependencies", {}), **value.get("optionalDependencies", {}), **value.get("peerDependencies", {})}
        for dependency in dependencies:
            bundle.require(re.fullmatch(r"(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+", dependency), "INVALID_DEPENDENCY_NAME")
            found = None
            for parent in [PurePosixPath(name), *PurePosixPath(name).parents]:
                check = str(parent / "node_modules" / dependency)
                if check in packages:
                    found = check
                    break
            optional = dependency in value.get("optionalDependencies", {}) or value.get("peerDependenciesMeta", {}).get(dependency, {}).get("optional")
            bundle.require(found is not None or optional, "UNRESOLVED_LOCK_DEPENDENCY:" + dependency)
            if found is not None:
                pending.append(found)
    minimal_package = {"name": "ava-gemini-private-deps", "version": "1.0.0", "private": True,
                       "dependencies": {AUTH_NAME: AUTH_VERSION}}
    minimal_lock = {"name": minimal_package["name"], "version": "1.0.0", "lockfileVersion": 3,
                    "requires": True, "packages": {"": {"name": minimal_package["name"], "version": "1.0.0",
                        "dependencies": minimal_package["dependencies"]}, **dict(sorted(selected.items()))}}
    return minimal_package, minimal_lock


def build(args):
    for sha in (args.base, args.candidate):
        bundle.validate_commit(args.repo, sha)
    bundle.git(args.repo, "merge-base", "--is-ancestor", args.base, args.candidate)
    bundle.require(not args.output.exists() and not args.output.is_symlink(), "OUTPUT_EXISTS")
    build_receipt = json.loads(args.frontend_receipt.read_text())
    bundle.require(build_receipt["sourceCommit"] == args.candidate, "FRONTEND_COMMIT_MISMATCH")
    inventory = json.loads(args.inventory.read_text())
    selected = runtime_paths(args.repo, args.base, args.candidate)
    sources = {path: bundle.blob(args.repo, args.candidate, "whatsapp_crm/" + path) for path in selected}
    package, lock = dependency_lock(args.repo, args.base, args.candidate)
    package_bytes = (json.dumps(package, indent=2) + "\n").encode()
    lock_bytes = (json.dumps(lock, indent=2) + "\n").encode()
    frontend = bundle.frontend_artifact(args.frontend_dist, build_receipt["files"])
    manifest = {"baseCommit": args.base, "candidateCommit": args.candidate,
        "dependency": {"name": AUTH_NAME, "version": AUTH_VERSION, "isolated": True,
                       "baseNodeModulesReplaced": False, "packageCount": len(lock["packages"]) - 1,
                       "lockSHA256": bundle.sha(lock_bytes), "packageSHA256": bundle.sha(package_bytes)}, "services": {}}
    for service, name in (("crm", "whatsapp_crm"), ("worker", "asterisk-ai-voice-agent-provisioning_worker-1")):
        before = inventory[name]
        bundle.require(re.fullmatch(r"sha256:[0-9a-f]{64}", before["image"]), "PINNED_BASE_IMAGE_REQUIRED")
        overrides = bundle.file_commit_overrides(args.repo, getattr(args, service + "_base_file_commit"), selected)
        context = args.output / service
        fences, hashes, origins = {}, {}, {}
        for path, content in sources.items():
            origin = overrides.get(path, args.base)
            old = bundle.blob(args.repo, origin, "whatsapp_crm/" + path, optional=True)
            expected = bundle.sha(old) if old is not None else None
            bundle.require(before["sourceHashes"].get(path) == expected, "PRODUCTION_SOURCE_DRIFT:" + service + ":" + path)
            fences[path], origins[path] = expected, origin
            target = context / "payload" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            hashes[path] = bundle.sha(content)
        deps = context / "deps"
        deps.mkdir(parents=True)
        (deps / "package.json").write_bytes(package_bytes)
        (deps / "package-lock.json").write_bytes(lock_bytes)
        base_tag = "ava-gemini-text-base-" + service + ":" + before["image"].removeprefix("sha256:")
        dockerfile = f"FROM {base_tag}\n"
        if service == "worker":
            dockerfile += "USER 0:0\n"
        dockerfile += "COPY deps/ /app/ava-gemini-deps/\n"
        dockerfile += "RUN test ! -e /app/node_modules/google-auth-library && test ! -L /app/node_modules/google-auth-library && "
        dockerfile += "npm ci --prefix /app/ava-gemini-deps --omit=dev --ignore-scripts --no-audit --no-fund && "
        dockerfile += "ln -s /app/ava-gemini-deps/node_modules/google-auth-library /app/node_modules/google-auth-library && "
        dockerfile += "find /app/ava-gemini-deps -type d -exec chmod 0755 {} + && "
        dockerfile += "find /app/ava-gemini-deps -type f -exec chmod 0644 {} +\n"
        dockerfile += "COPY --chown=1000:986 payload/ /app/\n" if service == "worker" else "COPY payload/ /app/\n"
        hashes["ava-gemini-deps/package.json"] = bundle.sha(package_bytes)
        hashes["ava-gemini-deps/package-lock.json"] = bundle.sha(lock_bytes)
        if service == "crm":
            for path, content in frontend.items():
                target = context / "frontend" / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            dockerfile += "COPY frontend/ /app/frontend/dist/\n"
            hashes.update({"frontend/dist/" + path: bundle.sha(content) for path, content in frontend.items()})
        dockerfile += "RUN find /app/src -type d -exec chmod 0755 {} +\n"
        if service == "crm":
            dockerfile += "RUN find /app/frontend/dist -type d -exec chmod 0755 {} +\n"
        if service == "worker":
            dockerfile += "USER 1000:986\n"
        dockerfile += f"LABEL org.opencontainers.image.revision={args.candidate}\n"
        (context / "Dockerfile").write_text(dockerfile)
        for path in context.rglob("*"):
            bundle.require(not path.is_symlink(), "BUILD_CONTEXT_LINK_FORBIDDEN")
            if path.is_dir():
                path.chmod(0o755)
            elif path.is_file():
                path.chmod(0o644)
            else:
                raise RuntimeError("BUILD_CONTEXT_SPECIAL_FILE_FORBIDDEN")
        context.chmod(0o755)
        manifest["services"][service] = {"container": name, "baseImage": before["image"], "baseTag": base_tag,
            "baseFiles": fences, "baseFileCommits": origins, "files": hashes,
            "preserveUnselectedProductionFiles": True, "preserveBaseDependencies": True}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return {"candidate": args.candidate, "selectedRuntimeFiles": len(selected), "newFrontendFiles": len(frontend),
            "isolatedDependencyPackages": len(lock["packages"]) - 1, "output": str(args.output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repo", "inventory", "frontend-dist", "frontend-receipt", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("base", "candidate"):
        parser.add_argument("--" + name, required=True)
    for service in ("crm", "worker"):
        parser.add_argument("--" + service + "-base-file-commit", action="append", default=[])
    print(json.dumps(build(parser.parse_args())))


if __name__ == "__main__":
    main()
