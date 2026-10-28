#!/usr/bin/env python3
"""Build a reviewed two-image release bundle from exact Git objects, offline.

No Docker, SSH, database, npm, or application commands are invoked. Worktree
source is never copied: all runtime bytes come from candidate commit blobs.

When a reviewed production image contains an existing file from another exact
Git commit, pin that provenance explicitly, for example:
  --crm-base-file-commit provisioning-worker.js=c1fd255876573f433aadae5ac84ff279243ac66b
Repeat --crm-base-file-commit or --worker-base-file-commit for additional reviewed
files. Paths are relative to /app. This derives the fence hash from a Git blob;
it never accepts a supplied source hash or changes candidate payload bytes.
Pin an unchanged JavaScript dependency in both overlays with, for example:
  --runtime-support-file src/services/provisioning/business-provisioning-store.service.js
Support files use candidate Git bytes and each service's reviewed source fence.
Test provenance exceptions require an explicit --contract-support-file selection:
  --contract-support-file tests/identity-protocol.test.js
  --crm-base-file-commit tests/identity-protocol.test.js=d74011ee97b82aacc3333de964b8c731637410fd
For a selected contract test absent from a reviewed pinned image, declare:
  --crm-absent-contract-support-file tests/team-identity-v2.test.js
Repeat the worker equivalents independently. Absence never applies to runtime
source; baseFileCommits retains the service baseline SHA and the explicit
absentContractSupportFiles list distinguishes this test-only absence declaration.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile

COMMIT = re.compile(r"^[0-9a-f]{40}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
SERVICES = ("whatsapp_crm", "provisioning_worker")
RUNTIME_ROOT = "whatsapp_crm/"
# Expand only after the new setting has been reviewed with the backend contract.
BOOLEAN_ENV = {"AVA_SELF_REGISTRATION_ENABLED", "AVA_PASSWORD_RECOVERY_NO_REDIRECT", "AVA_TEAM_NEW_ACCOUNT_ENABLED"}
EXACT_ENV = {"WHATSAPP_CRM_PUBLIC_URL": "https://wh.meludtech.tech",
             "AVA_OIDC_CLIENT_ID": "ava-web"}


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value
            and all(ord(c) >= 32 and ord(c) != 127 for c in value), "INVALID_PATH")
    parts = value.split("/")
    require(not value.startswith("/") and all(p not in ("", ".", "..") for p in parts),
            "INVALID_PATH")
    return PurePosixPath(value)


def git(repo, *args, optional=False):
    result = subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if optional and result.returncode:
        return None
    require(result.returncode == 0, "GIT_COMMAND_FAILED")
    return result.stdout


def validate_commit(repo, commit):
    require(isinstance(commit, str) and COMMIT.fullmatch(commit), "EXACT_COMMIT_REQUIRED")
    require(git(repo, "cat-file", "-t", commit).strip() == b"commit", "COMMIT_OBJECT_REQUIRED")


def blob(repo, commit, path, optional=False):
    relative(path)
    tree = git(repo, "ls-tree", "-z", commit, "--", path)
    if not tree:
        require(optional, "GIT_SOURCE_MISSING")
        return None
    records = tree.rstrip(b"\0").split(b"\0")
    require(len(records) == 1, "GIT_SOURCE_AMBIGUOUS")
    metadata, name = records[0].split(b"\t", 1)
    mode, kind, oid = metadata.split()
    require(name.decode() == path and mode in (b"100644", b"100755") and kind == b"blob",
            "REGULAR_GIT_BLOB_REQUIRED")
    return git(repo, "cat-file", "blob", oid.decode())


OPERATOR_SCRIPTS = frozenset({"scripts/team-enrollment-lease-recovery.js",
                              "scripts/team-email-reconciliation.js"})


def is_runtime(path):
    relative(path)
    return (path in OPERATOR_SCRIPTS or path in ("server.js", "provisioning-worker.js", "test-helper.js")
            or path.startswith(("src/", "tests/")) and path.endswith(".js"))


def file_commit_overrides(repo, entries, selected, contract_support=()):
    result = {}
    for entry in entries:
        require(isinstance(entry, str) and entry.count("=") == 1, "INVALID_BASE_FILE_COMMIT")
        path, commit = entry.split("=", 1)
        relative(path)
        require(path in ("server.js", "provisioning-worker.js")
                or path.startswith("src/") and path.endswith(".js")
                or path.startswith("tests/") and path.endswith(".js") and path in contract_support,
                "BASE_FILE_COMMIT_PATH_FORBIDDEN")
        require(path in selected, "BASE_FILE_COMMIT_NOT_OVERLAID")
        require(path not in result, "DUPLICATE_BASE_FILE_COMMIT")
        validate_commit(repo, commit)
        # An explicit exception must describe an existing regular runtime file,
        # not waive the absence contract of an addition or supply arbitrary bytes.
        blob(repo, commit, RUNTIME_ROOT + path)
        result[path] = commit
    return result


def absent_contract_support(entries, selected, contract_support, exceptions):
    result = set()
    for path in entries:
        relative(path)
        require(path == "test-helper.js" or path.startswith("tests/") and path.endswith(".js"),
                "ABSENT_CONTRACT_SUPPORT_PATH_FORBIDDEN")
        require(path in contract_support and path in selected, "ABSENT_CONTRACT_SUPPORT_NOT_EXPLICIT")
        require(path not in result, "DUPLICATE_ABSENT_CONTRACT_SUPPORT")
        require(path not in exceptions, "BASE_FILE_COMMIT_ABSENCE_CONFLICT")
        result.add(path)
    return result


def runtime_changes(repo, base, candidate, frontend, check_frontend=True):
    records = git(repo, "diff", "--name-status", "--no-renames", "-z", base, candidate).split(b"\0")
    selected = []
    for index in range(0, len(records) - 1, 2):
        status, raw_path = records[index:index + 2]
        path = raw_path.decode("utf-8")
        relative(path)
        if not path.startswith(RUNTIME_ROOT):
            continue
        rel = path[len(RUNTIME_ROOT):]
        if is_runtime(rel):
            require(status in (b"A", b"M"), "RUNTIME_DELETION_OR_TYPE_CHANGE")
            selected.append(rel)
        elif rel.startswith("frontend/"):
            if not check_frontend:
                continue
            require(PurePosixPath(rel).name not in
                    ("package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"),
                    "DEPENDENCY_CHANGE_UNSUPPORTED")
            require(frontend, "FRONTEND_ARTIFACT_REQUIRED")
            require(status in (b"A", b"M", b"D"), "FRONTEND_TYPE_CHANGE")
        elif (rel.startswith(("docs/", "scripts/", "tests/", ".github/"))
              or rel.endswith(".md") or rel in (".gitignore", ".env.example")):
            continue
        else:
            # Includes dependencies, Dockerfiles, config, assets, non-JS src,
            # and any unknown runtime input that the overlay cannot reproduce.
            raise RuntimeError("RUNTIME_CHANGE_UNSUPPORTED")
    require(selected, "EMPTY_RUNTIME_OVERLAY")
    return sorted(selected)


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (ValueError, OSError):
        raise RuntimeError("INVALID_JSON_INPUT") from None


def hash_map(value, nullable=False):
    require(isinstance(value, dict) and value, "HASH_MAP_REQUIRED")
    for path, digest in value.items():
        relative(path)
        require(nullable and digest is None or isinstance(digest, str) and HASH.fullmatch(digest),
                "INVALID_HASH_MAP")
    return value


def schema_objects(value):
    require(isinstance(value, list) and value, "SCHEMA_OBJECTS_REQUIRED")
    seen = set()
    for obj in value:
        require(isinstance(obj, dict) and set(obj) == {"name", "type", "tbl_name", "sqlHash"},
                "INVALID_SCHEMA_OBJECT")
        require(obj["type"] in ("table", "index", "trigger")
                and isinstance(obj["name"], str) and obj["name"]
                and obj["name"] not in seen and isinstance(obj["tbl_name"], str)
                and obj["tbl_name"] and isinstance(obj["sqlHash"], str)
                and HASH.fullmatch(obj["sqlHash"]), "INVALID_SCHEMA_OBJECT")
        seen.add(obj["name"])
    return value


def environment(value):
    require(isinstance(value, dict) and set(value) <= set(SERVICES), "INVALID_ENV_SERVICES")
    result = {service: {} for service in SERVICES}
    for service, settings in value.items():
        require(isinstance(settings, dict), "INVALID_ENV_SETTINGS")
        for key, val in settings.items():
            require(key in BOOLEAN_ENV | set(EXACT_ENV), "ENV_KEY_NOT_AUTHORIZED")
            require(key != "AVA_PASSWORD_RECOVERY_NO_REDIRECT" or service == "provisioning_worker",
                    "ENV_KEY_SERVICE_FORBIDDEN")
            require(isinstance(val, str), "ENV_VALUE_MUST_BE_STRING")
            if key in BOOLEAN_ENV:
                require(val in ("true", "false"), "INVALID_BOOLEAN_ENV")
            else:
                require(val == EXACT_ENV[key], "INVALID_REVIEWED_ENV_VALUE")
            result[service][key] = val
    return result


def runner(repo, candidate, input_path, output_name):
    path = Path(input_path)
    if not path.is_absolute():
        path = repo / path
    require(not path.is_symlink() and path.is_file(), "RUNNER_FILE_REQUIRED")
    try:
        repo_path = path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        raise RuntimeError("RUNNER_MUST_BE_IN_CANDIDATE_REPOSITORY") from None
    data = blob(repo, candidate, repo_path)
    require(path.read_bytes() == data, "RUNNER_WORKTREE_DIFFERS_FROM_CANDIDATE")
    require(repo_path.endswith(".cjs"), "CJS_RUNNER_REQUIRED")
    return {"path": output_name, "sha256": sha(data), "repositoryPath": repo_path,
            "candidateCommit": candidate}, data


def frontend_artifact(root, expected):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), "FRONTEND_DIRECTORY_REQUIRED")
    result = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "FRONTEND_SYMLINK_FORBIDDEN")
        if path.is_dir():
            continue
        require(path.is_file(), "FRONTEND_SPECIAL_FILE_FORBIDDEN")
        name = path.relative_to(root).as_posix()
        relative(name)
        data = path.read_bytes()
        require(expected.get(name) == sha(data), "FRONTEND_HASH_MISMATCH")
        result[name] = data
    require(set(result) == set(expected), "FRONTEND_FILE_SET_MISMATCH")
    require("index.html" in result and any(p.startswith("assets/") and p.endswith(".js") for p in result),
            "FRONTEND_ARTIFACT_INCOMPLETE")
    return result


def build(args):
    repo = Path(args.repo).resolve()
    validate_commit(repo, args.base_commit)
    validate_commit(repo, args.worker_base_commit)
    validate_commit(repo, args.candidate_commit)
    service_commits = {"whatsapp_crm": args.base_commit, "provisioning_worker": args.worker_base_commit}
    for base_commit in service_commits.values():
        require(git(repo, "merge-base", "--is-ancestor", base_commit, args.candidate_commit,
                    optional=True) is not None, "BASE_NOT_CANDIDATE_ANCESTOR")
    require(IMAGE.fullmatch(args.crm_image) and IMAGE.fullmatch(args.worker_image), "PINNED_IMAGE_REQUIRED")
    output = Path(args.output).absolute()
    require(not output.exists() and not output.is_symlink(), "OUTPUT_ALREADY_EXISTS")
    require(bool(args.frontend_dist) == bool(args.frontend_sha256)
            == bool(args.frontend_base_sha256), "FRONTEND_REVIEW_MAPS_REQUIRED")
    support, contract_support = [], set()
    for path in args.contract_support_file:
        relative(path)
        require(is_runtime(path) and (path.startswith("tests/") or path == "test-helper.js"),
                "INVALID_CONTRACT_SUPPORT_FILE")
        support.append(path)
        contract_support.add(path)
    for path in getattr(args, "runtime_support_file", []):
        relative(path)
        require(path in OPERATOR_SCRIPTS or path.startswith("src/") and path.endswith(".js"),
                "INVALID_RUNTIME_SUPPORT_FILE")
        support.append(path)
    allowed_schema = schema_objects(read_json(args.schema_json))
    env = environment(read_json(args.environment_json) if args.environment_json else {})
    migration, migration_data = runner(repo, args.candidate_commit, args.migration_runner, "migrations.cjs")
    contract, contract_data = runner(repo, args.candidate_commit, args.contract_runner, "contract.cjs")
    manifest = {"schemaVersion": 2, "baseCommit": args.base_commit,
                "candidateCommit": args.candidate_commit, "publicBaseUrl": "https://wh.meludtech.tech",
                "publicRoutes": ["/login", "/register", "/forgot-password"], "services": {},
                "migrationRunner": migration, "contractRunner": contract,
                "allowedNewSchema": allowed_schema,
                "contractSupportFiles": sorted(contract_support)}
    payloads, bases, base_file_commits, absent_support = {}, {}, {}, {}
    for service in SERVICES:
        baseline = service_commits[service]
        # Each image has its own reviewed source baseline. An older worker may
        # require additional runtime overlays that the current CRM already has.
        files = sorted(set(runtime_changes(repo, baseline, args.candidate_commit,
                                           bool(args.frontend_dist),
                                           check_frontend=service == "whatsapp_crm") + support))
        entries = getattr(args, "crm_base_file_commit" if service == "whatsapp_crm"
                          else "worker_base_file_commit", [])
        exceptions = file_commit_overrides(repo, entries, files, contract_support)
        absence_entries = getattr(args, "crm_absent_contract_support_file" if service == "whatsapp_crm"
                                  else "worker_absent_contract_support_file", [])
        absent_support[service] = absent_contract_support(absence_entries, files, contract_support, exceptions)
        base_file_commits[service] = {path: exceptions.get(path, baseline) for path in files}
        payloads[service] = {path: blob(repo, args.candidate_commit, RUNTIME_ROOT + path) for path in files}
        base_blobs = {path: None if path in absent_support[service] else
                      blob(repo, base_file_commits[service][path], RUNTIME_ROOT + path,
                           optional=path not in exceptions) for path in files}
        bases[service] = {path: None if data is None else sha(data) for path, data in base_blobs.items()}
    if args.frontend_dist:
        artifact_map = hash_map(read_json(args.frontend_sha256))
        artifact_base = hash_map(read_json(args.frontend_base_sha256))
        frontend = frontend_artifact(args.frontend_dist, artifact_map)
        for path, data in frontend.items():
            name = "frontend/dist/" + path
            payloads["whatsapp_crm"][name] = data
            bases["whatsapp_crm"][name] = artifact_base.get(path)
        manifest["frontendProvenance"] = {"candidateCommit": args.candidate_commit,
            "artifactMapSha256": sha(canonical(artifact_map)),
            "baseArtifactMapSha256": sha(canonical(artifact_base))}
    for service, image, short in zip(SERVICES, (args.crm_image, args.worker_image), ("crm", "worker")):
        hashes = {path: sha(data) for path, data in payloads[service].items()}
        fingerprint = sha(canonical({"candidateCommit": args.candidate_commit, "baseImageId": image,
                                     "files": hashes}))[:12]
        manifest["services"][service] = {"baseImageId": image,
            "baseCommit": service_commits[service],
            "baseFileCommits": base_file_commits[service],
            "absentContractSupportFiles": sorted(absent_support[service]),
            "candidateTag": f"ava-registration-{short}:{args.candidate_commit[:12]}-{fingerprint}",
            "files": hashes, "baseFiles": bases[service], "environment": env[service]}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".ava-registration-bundle-", dir=output.parent))
    try:
        for service in SERVICES:
            for name, data in payloads[service].items():
                target = temporary / "payload" / service / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        (temporary / "migrations.cjs").write_bytes(migration_data)
        (temporary / "contract.cjs").write_bytes(contract_data)
        manifest_bytes = json.dumps(manifest, sort_keys=True, indent=2).encode() + b"\n"
        (temporary / "manifest.json").write_bytes(manifest_bytes)
        os.rename(temporary, output)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {"manifestSha256": sha(manifest_bytes), "baseCommit": args.base_commit,
            "workerBaseCommit": args.worker_base_commit,
            "candidateCommit": args.candidate_commit,
            "fileCounts": {name: len(payloads[name]) for name in SERVICES}}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    for name in ("repo", "base-commit", "worker-base-commit", "candidate-commit", "crm-image", "worker-image",
                 "migration-runner", "contract-runner", "schema-json", "output"):
        result.add_argument("--" + name, required=True)
    for name in ("frontend-dist", "frontend-sha256", "frontend-base-sha256", "environment-json"):
        result.add_argument("--" + name)
    result.add_argument("--contract-support-file", action="append", default=[],
                        help="Reviewed /app-relative tests/*.js or test-helper.js, copied from candidate Git")
    result.add_argument("--runtime-support-file", action="append", default=[],
                        help="Pin an unchanged /app-relative src/**/*.js dependency in both image overlays; repeat as needed")
    for service in ("crm", "worker"):
        result.add_argument("--" + service + "-base-file-commit", action="append", default=[],
                            metavar="PATH=40HEX", help="Reviewed runtime or explicitly selected contract test Git provenance; repeat as needed")
        result.add_argument("--" + service + "-absent-contract-support-file", action="append", default=[],
                            metavar="PATH", help="Declare an explicitly selected contract test absent from this pinned image; repeat as needed")
    return result


def main():
    try:
        print(json.dumps(build(parser().parse_args()), sort_keys=True))
        return 0
    except (RuntimeError, OSError, UnicodeError) as exc:
        # Never echo paths, file bytes, environment values, or subprocess stderr.
        code = str(exc) if isinstance(exc, RuntimeError) else "BUNDLE_IO_FAILED"
        print(json.dumps({"error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
