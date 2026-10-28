#!/usr/bin/env python3
"""Offline synthetic Git fixtures; no production or Docker access."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("build_bundle", Path(__file__).with_name("build_bundle.py"))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def digest(value):
    return hashlib.sha256(value).hexdigest()


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.write("whatsapp_crm/src/identity.js", "module.exports='old';\n")
        self.write("whatsapp_crm/server.js", "require('./src/identity');\n")
        self.write("whatsapp_crm/test-helper.js", "module.exports={};\n")
        self.write("whatsapp_crm/package.json", '{"dependencies":{}}\n')
        self.base = self.commit()
        self.write("whatsapp_crm/src/identity.js", "module.exports='new';\n")
        self.write("whatsapp_crm/src/recovery.js", "module.exports={};\n")
        self.write("scripts/ava-registration-release/migrations.cjs", "console.log('migration');\n")
        self.write("scripts/ava-registration-release/contract.cjs", "console.log('contract');\n")
        self.candidate = self.commit()
        self.schema = self.root / "schema.json"
        self.schema.write_text(json.dumps([{"name": "recovery", "type": "table", "tbl_name": "recovery",
                                           "sqlHash": "a" * 64}]))
        self.args = argparse.Namespace(repo=str(self.repo), base_commit=self.base, worker_base_commit=self.base,
            candidate_commit=self.candidate, crm_image="sha256:" + "1" * 64,
            worker_image="sha256:" + "2" * 64,
            migration_runner="scripts/ava-registration-release/migrations.cjs",
            contract_runner="scripts/ava-registration-release/contract.cjs",
            schema_json=str(self.schema), output=str(self.root / "bundle"),
            frontend_dist=None, frontend_sha256=None, frontend_base_sha256=None,
            environment_json=None, contract_support_file=[], runtime_support_file=[],
            crm_base_file_commit=[], worker_base_file_commit=[],
            crm_absent_contract_support_file=[], worker_absent_contract_support_file=[])

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, value):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def manifest(self):
        return json.loads((Path(self.args.output) / "manifest.json").read_text())

    def assert_rejected(self, code):
        with self.assertRaisesRegex(RuntimeError, "^" + code + "$"):
            builder.build(self.args)
        self.assertFalse(Path(self.args.output).exists())

    def add_candidate_change(self, path, value):
        self.write(path, value)
        self.args.candidate_commit = self.commit()

    def frontend(self):
        root = self.root / "dist"
        (root / "assets").mkdir(parents=True)
        (root / "index.html").write_bytes(b"<script src='/assets/app.js'></script>")
        (root / "assets/app.js").write_bytes(b"console.log('reviewed');")
        expected = {p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in root.rglob("*") if p.is_file()}
        expected_path = self.root / "frontend-map.json"
        expected_path.write_text(json.dumps(expected))
        baseline = self.root / "frontend-base-map.json"
        baseline.write_text(json.dumps({"index.html": "3" * 64, "assets/old.js": "4" * 64}))
        self.args.frontend_dist = str(root)
        self.args.frontend_sha256 = str(expected_path)
        self.args.frontend_base_sha256 = str(baseline)
        return root

    def test_two_services_use_git_not_dirty_source(self):
        self.write("whatsapp_crm/src/identity.js", "DIRTY SECRET SENTINEL")
        self.write("whatsapp_crm/src/untracked.js", "DIRTY SECRET SENTINEL")
        result = builder.build(self.args)
        manifest = self.manifest()
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertEqual(result["manifestSha256"], digest((Path(self.args.output) / "manifest.json").read_bytes()))
        for service in builder.SERVICES:
            data = manifest["services"][service]
            self.assertEqual(set(data["files"]), {"src/identity.js", "src/recovery.js"})
            self.assertEqual(data["baseFiles"]["src/identity.js"], digest(b"module.exports='old';\n"))
            self.assertIsNone(data["baseFiles"]["src/recovery.js"])
            self.assertEqual((Path(self.args.output) / "payload" / service / "src/identity.js").read_bytes(),
                             b"module.exports='new';\n")
        self.assertEqual(manifest["publicRoutes"], ["/login", "/register", "/forgot-password"])
        self.assertEqual(manifest["migrationRunner"]["candidateCommit"], self.candidate)

    def test_deterministic_manifest(self):
        first = builder.build(self.args)
        self.args.output = str(self.root / "bundle2")
        self.assertEqual(first, builder.build(self.args))

    def test_changed_revocation_worker_automatically_overlaid_in_both_images(self):
        path = "src/services/identity/revocation-worker.js"
        self.write("whatsapp_crm/" + path, "module.exports='old revocation';\n")
        existing_revocation = self.commit()
        self.args.base_commit = existing_revocation
        self.args.worker_base_commit = existing_revocation
        self.write("whatsapp_crm/" + path, "module.exports='durable registration revocation';\n")
        self.args.candidate_commit = self.commit()
        builder.build(self.args)
        for service in builder.SERVICES:
            settings = self.manifest()["services"][service]
            self.assertEqual(settings["files"][path], digest(b"module.exports='durable registration revocation';\n"))
            self.assertEqual(settings["baseFiles"][path], digest(b"module.exports='old revocation';\n"))
            self.assertEqual(settings["baseFileCommits"][path], existing_revocation)
            self.assertEqual((Path(self.args.output) / "payload" / service / path).read_bytes(),
                             b"module.exports='durable registration revocation';\n")

    def test_worker_older_reviewed_baseline_gets_own_diff(self):
        # CRM already has recovery; the older worker does not. Both final images
        # get candidate bytes, but only worker needs recovery as a new file.
        self.args.base_commit = self.candidate
        self.add_candidate_change("whatsapp_crm/src/identity.js", "module.exports='newer';\n")
        builder.build(self.args)
        manifest = self.manifest()
        crm = manifest["services"]["whatsapp_crm"]
        worker = manifest["services"]["provisioning_worker"]
        self.assertEqual(crm["baseCommit"], self.candidate)
        self.assertEqual(worker["baseCommit"], self.base)
        self.assertEqual(set(crm["files"]), {"src/identity.js"})
        self.assertEqual(set(worker["files"]), {"src/identity.js", "src/recovery.js"})
        self.assertEqual(crm["baseFiles"]["src/identity.js"], digest(b"module.exports='new';\n"))
        self.assertEqual(worker["baseFiles"]["src/identity.js"], digest(b"module.exports='old';\n"))
        self.assertIsNone(worker["baseFiles"]["src/recovery.js"])

    def test_worker_baseline_requires_exact_sha(self):
        self.args.worker_base_commit = "main"
        self.assert_rejected("EXACT_COMMIT_REQUIRED")

    def test_all_source_fences_include_default_git_provenance(self):
        builder.build(self.args)
        for service in builder.SERVICES:
            settings = self.manifest()["services"][service]
            self.assertEqual(settings["baseFileCommits"], {path: self.base for path in settings["files"]})

    def test_reviewed_per_file_commit_corrects_only_source_fence(self):
        # Simulate a production-only baked hotfix with a real, reviewed Git
        # commit. The source fence from the default baseline correctly misses it.
        self.write("whatsapp_crm/src/identity.js", "module.exports='production hotfix';\n")
        hotfix_commit = self.commit()
        hotfix_hash = digest(b"module.exports='production hotfix';\n")
        builder.build(self.args)
        original = self.manifest()
        self.assertNotEqual(original["services"]["whatsapp_crm"]["baseFiles"]["src/identity.js"], hotfix_hash)
        self.args.output = str(self.root / "reviewed-bundle")
        self.args.crm_base_file_commit = ["src/identity.js=" + hotfix_commit]
        builder.build(self.args)
        reviewed = self.manifest()
        crm = reviewed["services"]["whatsapp_crm"]
        worker = reviewed["services"]["provisioning_worker"]
        self.assertEqual(crm["baseFiles"]["src/identity.js"], hotfix_hash)
        self.assertEqual(crm["baseFileCommits"]["src/identity.js"], hotfix_commit)
        self.assertEqual(crm["files"], original["services"]["whatsapp_crm"]["files"])
        self.assertEqual(worker, original["services"]["provisioning_worker"])
        self.assertEqual(crm["baseFiles"]["src/recovery.js"], None)

    def test_worker_file_commit_is_independent_from_crm(self):
        self.write("whatsapp_crm/src/identity.js", "module.exports='worker hotfix';\n")
        worker_hotfix = self.commit()
        self.args.worker_base_file_commit = ["src/identity.js=" + worker_hotfix]
        builder.build(self.args)
        services = self.manifest()["services"]
        self.assertEqual(services["provisioning_worker"]["baseFileCommits"]["src/identity.js"], worker_hotfix)
        self.assertEqual(services["whatsapp_crm"]["baseFileCommits"]["src/identity.js"], self.base)

    def test_file_commit_override_requires_exact_sha(self):
        self.args.crm_base_file_commit = ["src/identity.js=HEAD"]
        self.assert_rejected("EXACT_COMMIT_REQUIRED")

    def test_file_commit_override_requires_existing_file(self):
        self.args.crm_base_file_commit = ["src/recovery.js=" + self.base]
        self.assert_rejected("GIT_SOURCE_MISSING")

    def test_file_commit_override_requires_selected_overlay(self):
        self.args.crm_base_file_commit = ["server.js=" + self.base]
        self.assert_rejected("BASE_FILE_COMMIT_NOT_OVERLAID")

    def test_file_commit_cannot_override_dependencies_tests_or_frontend(self):
        for path in ("package.json", "tests/check.js", "test-helper.js", "frontend/dist/index.html"):
            with self.subTest(path=path):
                self.args.crm_base_file_commit = [path + "=" + self.base]
                self.assert_rejected("BASE_FILE_COMMIT_PATH_FORBIDDEN")

    def test_explicit_contract_test_provenance_uses_reviewed_git_blob(self):
        path = "tests/identity-protocol.test.js"
        self.write("whatsapp_crm/" + path, "module.exports='reviewed production contract';\n")
        contract_commit = self.commit()
        self.write("whatsapp_crm/" + path, "module.exports='candidate contract';\n")
        self.args.candidate_commit = self.commit()
        self.args.contract_support_file = [path]
        self.args.crm_base_file_commit = [path + "=" + contract_commit]
        self.args.worker_base_file_commit = [path + "=" + contract_commit]
        builder.build(self.args)
        self.assertEqual(self.manifest()["contractSupportFiles"], [path])
        for service in builder.SERVICES:
            settings = self.manifest()["services"][service]
            self.assertEqual(settings["baseFileCommits"][path], contract_commit)
            self.assertEqual(settings["baseFiles"][path], digest(b"module.exports='reviewed production contract';\n"))
            self.assertEqual(settings["files"][path], digest(b"module.exports='candidate contract';\n"))

    def test_automatically_changed_test_still_requires_explicit_support_for_provenance(self):
        path = "tests/identity-protocol.test.js"
        self.add_candidate_change("whatsapp_crm/" + path, "module.exports={};\n")
        self.args.crm_base_file_commit = [path + "=" + self.args.candidate_commit]
        self.assert_rejected("BASE_FILE_COMMIT_PATH_FORBIDDEN")

    def test_explicit_test_provenance_cannot_supply_hash(self):
        path = "tests/identity-protocol.test.js"
        self.add_candidate_change("whatsapp_crm/" + path, "module.exports={};\n")
        self.args.contract_support_file = [path]
        self.args.crm_base_file_commit = [path + "=" + "a" * 64]
        self.assert_rejected("EXACT_COMMIT_REQUIRED")

    def contract_test_present_in_baseline(self):
        path = "tests/team-identity-v2.test.js"
        self.write("whatsapp_crm/" + path, "module.exports='existing baseline contract';\n")
        baseline = self.commit()
        self.args.base_commit = baseline
        self.args.worker_base_commit = baseline
        self.add_candidate_change("whatsapp_crm/src/recovery.js", "module.exports='updated recovery';\n")
        self.args.contract_support_file = [path]
        return path, baseline

    def test_contract_test_absence_is_explicit_and_service_scoped(self):
        path, baseline = self.contract_test_present_in_baseline()
        self.args.crm_absent_contract_support_file = [path]
        builder.build(self.args)
        crm = self.manifest()["services"]["whatsapp_crm"]
        worker = self.manifest()["services"]["provisioning_worker"]
        self.assertIsNone(crm["baseFiles"][path])
        self.assertEqual(crm["absentContractSupportFiles"], [path])
        self.assertEqual(crm["baseFileCommits"][path], baseline)
        self.assertEqual(crm["files"][path], digest(b"module.exports='existing baseline contract';\n"))
        self.assertEqual(worker["baseFiles"][path], digest(b"module.exports='existing baseline contract';\n"))
        self.assertEqual(worker["absentContractSupportFiles"], [])

    def test_contract_helper_can_be_explicitly_absent(self):
        self.args.contract_support_file = ["test-helper.js"]
        self.args.worker_absent_contract_support_file = ["test-helper.js"]
        builder.build(self.args)
        worker = self.manifest()["services"]["provisioning_worker"]
        self.assertIsNone(worker["baseFiles"]["test-helper.js"])
        self.assertEqual(worker["absentContractSupportFiles"], ["test-helper.js"])
        self.assertEqual(worker["baseFileCommits"]["test-helper.js"], self.base)

    def test_contract_absence_cannot_bypass_runtime_dependency_or_frontend_fence(self):
        for path in ("src/identity.js", "server.js", "provisioning-worker.js", "package.json",
                     "node_modules/module.js", "frontend/dist/assets/app.js"):
            with self.subTest(path=path):
                self.args.crm_absent_contract_support_file = [path]
                self.assert_rejected("ABSENT_CONTRACT_SUPPORT_PATH_FORBIDDEN")

    def test_contract_absence_requires_explicit_support_even_for_changed_test(self):
        path = "tests/team-identity-v2.test.js"
        self.add_candidate_change("whatsapp_crm/" + path, "module.exports={};\n")
        self.args.crm_absent_contract_support_file = [path]
        self.assert_rejected("ABSENT_CONTRACT_SUPPORT_NOT_EXPLICIT")

    def test_contract_absence_unknown_support_rejected(self):
        self.args.crm_absent_contract_support_file = ["tests/unknown.js"]
        self.assert_rejected("ABSENT_CONTRACT_SUPPORT_NOT_EXPLICIT")

    def test_duplicate_contract_absence_rejected(self):
        path, _ = self.contract_test_present_in_baseline()
        self.args.crm_absent_contract_support_file = [path, path]
        self.assert_rejected("DUPLICATE_ABSENT_CONTRACT_SUPPORT")

    def test_contract_absence_and_commit_provenance_conflict_rejected(self):
        path, baseline = self.contract_test_present_in_baseline()
        self.args.crm_base_file_commit = [path + "=" + baseline]
        self.args.crm_absent_contract_support_file = [path]
        self.assert_rejected("BASE_FILE_COMMIT_ABSENCE_CONFLICT")

    def test_contract_absence_path_traversal_rejected(self):
        self.args.crm_absent_contract_support_file = ["tests/../../src/identity.js"]
        self.assert_rejected("INVALID_PATH")

    def test_contract_absence_still_requires_regular_candidate_git_blob(self):
        path, _ = self.contract_test_present_in_baseline()
        candidate_path = self.repo / "whatsapp_crm" / path
        candidate_path.unlink()
        candidate_path.symlink_to("../src/identity.js")
        self.args.candidate_commit = self.commit()
        self.args.crm_absent_contract_support_file = [path]
        self.assert_rejected("RUNTIME_DELETION_OR_TYPE_CHANGE")

    def test_file_commit_duplicates_rejected(self):
        self.args.crm_base_file_commit = ["src/identity.js=" + self.base] * 2
        self.assert_rejected("DUPLICATE_BASE_FILE_COMMIT")

    def test_file_commit_source_hash_cannot_be_supplied(self):
        self.args.crm_base_file_commit = ["src/identity.js=" + "a" * 64]
        self.assert_rejected("EXACT_COMMIT_REQUIRED")

    def test_file_commit_path_traversal_rejected(self):
        self.args.crm_base_file_commit = ["src/../../server.js=" + self.base]
        self.assert_rejected("INVALID_PATH")

    def test_file_commit_git_symlink_rejected(self):
        path = self.repo / "whatsapp_crm/src/identity.js"
        path.unlink()
        path.symlink_to("recovery.js")
        symlink_commit = self.commit()
        self.args.crm_base_file_commit = ["src/identity.js=" + symlink_commit]
        self.assert_rejected("REGULAR_GIT_BLOB_REQUIRED")

    def test_frontend_keeps_separate_artifact_provenance(self):
        self.frontend()
        builder.build(self.args)
        services = self.manifest()["services"]
        self.assertNotIn("frontend/dist/index.html", services["whatsapp_crm"]["baseFileCommits"])
        self.assertIn("frontendProvenance", self.manifest())

    def test_worker_baseline_frontend_history_does_not_require_artifact(self):
        self.add_candidate_change("whatsapp_crm/frontend/src/OldLogin.jsx", "export default null;")
        self.args.base_commit = self.args.candidate_commit
        self.add_candidate_change("whatsapp_crm/src/identity.js", "module.exports='newer';\n")
        builder.build(self.args)
        self.assertFalse(any(p.startswith("frontend/") for p in
                             self.manifest()["services"]["provisioning_worker"]["files"]))

    def test_exact_git_sha_only(self):
        self.args.candidate_commit = "HEAD"
        self.assert_rejected("EXACT_COMMIT_REQUIRED")

    def test_exact_image_id_only(self):
        self.args.worker_image = "worker:latest"
        self.assert_rejected("PINNED_IMAGE_REQUIRED")

    def test_annotated_tag_object_not_commit(self):
        self.git("tag", "-a", "-m", "fixture", "review")
        self.args.candidate_commit = self.git("rev-parse", "review")
        self.assert_rejected("COMMIT_OBJECT_REQUIRED")

    def test_nonancestor_base_rejected(self):
        self.git("checkout", "--orphan", "unrelated")
        self.write("orphan", "unrelated")
        self.args.base_commit = self.commit()
        self.assert_rejected("BASE_NOT_CANDIDATE_ANCESTOR")

    def test_deletion_rejected(self):
        (self.repo / "whatsapp_crm/src/identity.js").unlink()
        self.args.candidate_commit = self.commit()
        self.assert_rejected("RUNTIME_DELETION_OR_TYPE_CHANGE")

    def test_dependency_change_rejected(self):
        self.add_candidate_change("whatsapp_crm/package.json", '{"dependencies":{"danger":"*"}}')
        self.assert_rejected("RUNTIME_CHANGE_UNSUPPORTED")

    def test_non_js_runtime_rejected(self):
        self.add_candidate_change("whatsapp_crm/src/config.json", '{}')
        self.assert_rejected("RUNTIME_CHANGE_UNSUPPORTED")

    def test_runtime_symlink_rejected(self):
        path = self.repo / "whatsapp_crm/src/recovery.js"
        path.unlink()
        path.symlink_to("identity.js")
        self.args.candidate_commit = self.commit()
        self.assert_rejected("REGULAR_GIT_BLOB_REQUIRED")

    def test_dirty_runner_rejected(self):
        self.write(self.args.contract_runner, "DIRTY SECRET SENTINEL")
        self.assert_rejected("RUNNER_WORKTREE_DIFFERS_FROM_CANDIDATE")

    def test_untracked_runner_rejected(self):
        self.write("scripts/untracked.cjs", "console.log('untracked')")
        self.args.contract_runner = "scripts/untracked.cjs"
        self.assert_rejected("GIT_SOURCE_MISSING")

    def test_external_runner_rejected(self):
        external = self.root / "external.cjs"
        external.write_text("console.log('external')")
        self.args.contract_runner = str(external)
        self.assert_rejected("RUNNER_MUST_BE_IN_CANDIDATE_REPOSITORY")

    def test_candidate_test_support_can_include_unchanged_helper(self):
        self.args.contract_support_file = ["test-helper.js"]
        builder.build(self.args)
        for service in builder.SERVICES:
            config = self.manifest()["services"][service]
            self.assertEqual(config["files"]["test-helper.js"], config["baseFiles"]["test-helper.js"])

    def test_unchanged_runtime_support_pins_both_images_and_provenance(self):
        # Identity is changed in this fixture; make it unchanged between the
        # selected baseline and a later candidate with only recovery modified.
        self.args.base_commit = self.candidate
        self.args.worker_base_commit = self.candidate
        self.add_candidate_change("whatsapp_crm/src/recovery.js", "module.exports='recovery updated';\n")
        self.args.runtime_support_file = ["src/identity.js"]
        self.write("whatsapp_crm/src/identity.js", "DIRTY SECRET SENTINEL")
        builder.build(self.args)
        for service in builder.SERVICES:
            config = self.manifest()["services"][service]
            self.assertEqual(config["files"]["src/identity.js"], digest(b"module.exports='new';\n"))
            self.assertEqual(config["files"]["src/identity.js"], config["baseFiles"]["src/identity.js"])
            self.assertEqual(config["baseFileCommits"]["src/identity.js"], self.candidate)
            self.assertEqual((Path(self.args.output) / "payload" / service / "src/identity.js").read_bytes(),
                             b"module.exports='new';\n")

    def test_reviewed_operator_cli_is_pinned_and_added_to_both_images(self):
        for name in sorted(builder.OPERATOR_SCRIPTS):
            self.write("whatsapp_crm/" + name, "module.exports='reviewed operator';\n")
        self.candidate = self.commit()
        self.args.candidate_commit = self.candidate
        self.args.runtime_support_file = sorted(builder.OPERATOR_SCRIPTS)
        builder.build(self.args)
        for service in builder.SERVICES:
            for name in builder.OPERATOR_SCRIPTS:
                config = self.manifest()["services"][service]
                self.assertIsNone(config["baseFiles"][name])
                self.assertEqual(config["files"][name], digest(b"module.exports='reviewed operator';\n"))
                self.assertEqual((Path(self.args.output) / "payload" / service / name).read_bytes(),
                                 b"module.exports='reviewed operator';\n")

    def test_runtime_support_requires_src_js_path(self):
        for path in ("package.json", "server.js", "tests/check.js", "test-helper.js", "node_modules/dependency.js",
                     "frontend/dist/assets/app.js", "src/config.json", "srcfoo/file.js", "scripts/arbitrary.js"):
            with self.subTest(path=path):
                self.args.runtime_support_file = [path]
                self.assert_rejected("INVALID_RUNTIME_SUPPORT_FILE")

    def test_runtime_support_path_traversal_rejected(self):
        self.args.runtime_support_file = ["src/../../secret.js"]
        self.assert_rejected("INVALID_PATH")

    def test_runtime_support_requires_candidate_git_file(self):
        self.write("whatsapp_crm/src/untracked.js", "module.exports={};")
        self.args.runtime_support_file = ["src/untracked.js"]
        self.assert_rejected("GIT_SOURCE_MISSING")

    def test_runtime_support_symlink_rejected(self):
        path = self.repo / "whatsapp_crm/src/support.js"
        path.symlink_to("identity.js")
        self.args.candidate_commit = self.commit()
        self.args.runtime_support_file = ["src/support.js"]
        self.assert_rejected("REGULAR_GIT_BLOB_REQUIRED")

    def test_runtime_support_duplicate_is_one_overlay_file(self):
        self.args.runtime_support_file = ["src/identity.js", "src/identity.js"]
        builder.build(self.args)
        for service in builder.SERVICES:
            self.assertEqual(set(self.manifest()["services"][service]["files"]),
                             {"src/identity.js", "src/recovery.js"})

    def test_contract_support_not_arbitrary_file(self):
        self.args.contract_support_file = ["package.json"]
        self.assert_rejected("INVALID_CONTRACT_SUPPORT_FILE")

    def test_support_traversal_rejected(self):
        self.args.contract_support_file = ["tests/../../secret.js"]
        self.assert_rejected("INVALID_PATH")

    def test_frontend_source_requires_artifact(self):
        self.add_candidate_change("whatsapp_crm/frontend/src/Register.jsx", "export default null;")
        self.assert_rejected("FRONTEND_ARTIFACT_REQUIRED")

    def test_frontend_only_crm_with_reviewed_baseline(self):
        self.frontend()
        builder.build(self.args)
        manifest = self.manifest()
        crm = manifest["services"]["whatsapp_crm"]
        worker = manifest["services"]["provisioning_worker"]
        self.assertEqual(crm["baseFiles"]["frontend/dist/index.html"], "3" * 64)
        self.assertIsNone(crm["baseFiles"]["frontend/dist/assets/app.js"])
        self.assertFalse(any(p.startswith("frontend/") for p in worker["files"]))
        self.assertEqual(manifest["frontendProvenance"]["candidateCommit"], self.candidate)

    def test_frontend_extra_file_rejected(self):
        root = self.frontend()
        (root / "unreviewed.txt").write_text("UNREVIEWED")
        self.assert_rejected("FRONTEND_HASH_MISMATCH")

    def test_frontend_missing_file_rejected(self):
        root = self.frontend()
        (root / "assets/app.js").unlink()
        self.assert_rejected("FRONTEND_FILE_SET_MISMATCH")

    def test_frontend_symlink_rejected(self):
        root = self.frontend()
        (root / "assets/app.js").unlink()
        (root / "assets/app.js").symlink_to("../index.html")
        self.assert_rejected("FRONTEND_SYMLINK_FORBIDDEN")

    def test_frontend_dependency_change_even_with_artifact_rejected(self):
        self.frontend()
        self.add_candidate_change("whatsapp_crm/frontend/package.json", "{}")
        self.assert_rejected("DEPENDENCY_CHANGE_UNSUPPORTED")

    def test_frontend_missing_baseline_map_rejected(self):
        self.frontend()
        self.args.frontend_base_sha256 = None
        self.assert_rejected("FRONTEND_REVIEW_MAPS_REQUIRED")

    def test_schema_hash_is_exact(self):
        self.schema.write_text(json.dumps([{"name": "recovery", "type": "table", "tbl_name": "recovery", "sqlHash": "sql"}]))
        self.assert_rejected("INVALID_SCHEMA_OBJECT")

    def test_schema_duplicates_rejected(self):
        objects = json.loads(self.schema.read_text())
        self.schema.write_text(json.dumps(objects + objects))
        self.assert_rejected("INVALID_SCHEMA_OBJECT")

    def test_explicit_boolean_environment(self):
        settings = self.root / "environment.json"
        settings.write_text(json.dumps({service: {"AVA_SELF_REGISTRATION_ENABLED": "true"} for service in builder.SERVICES}))
        self.args.environment_json = str(settings)
        builder.build(self.args)
        for service in builder.SERVICES:
            self.assertEqual(self.manifest()["services"][service]["environment"],
                             {"AVA_SELF_REGISTRATION_ENABLED": "true"})

    def test_recovery_no_redirect_flag_accepts_only_reviewed_boolean_strings(self):
        for value in ("true", "false"):
            with self.subTest(value=value):
                settings = self.root / "environment.json"
                intended = {"provisioning_worker": {"AVA_PASSWORD_RECOVERY_NO_REDIRECT": value}, "whatsapp_crm": {}}
                settings.write_text(json.dumps(intended))
                self.args.environment_json = str(settings)
                self.args.output = str(self.root / ("bundle-no-redirect-" + value))
                builder.build(self.args)
                for service in builder.SERVICES:
                    self.assertEqual(self.manifest()["services"][service]["environment"], intended[service])

    def test_staff_enrollment_boolean_is_explicit_and_validated_for_both_services(self):
        for value in ("true", "false"):
            intended = {service: {"AVA_TEAM_NEW_ACCOUNT_ENABLED": value} for service in builder.SERVICES}
            self.assertEqual(builder.environment(intended), intended)
        for value in ("TRUE", "1", "yes", True, None):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                builder.environment({"whatsapp_crm": {"AVA_TEAM_NEW_ACCOUNT_ENABLED": value}})

    def test_recovery_no_redirect_flag_is_forbidden_for_crm_even_when_false(self):
        for value in ("true", "false"):
            with self.subTest(value=value):
                settings = self.root / "environment.json"
                settings.write_text(json.dumps({"whatsapp_crm": {"AVA_PASSWORD_RECOVERY_NO_REDIRECT": value}}))
                self.args.environment_json = str(settings)
                self.assert_rejected("ENV_KEY_SERVICE_FORBIDDEN")

    def test_recovery_no_redirect_rejects_non_boolean_values(self):
        for value in ("1", "0", "TRUE", "False", "yes", "*", "SECRET_SENTINEL", True, False, None):
            with self.subTest(value=value):
                settings = self.root / "environment.json"
                settings.write_text(json.dumps({"provisioning_worker": {"AVA_PASSWORD_RECOVERY_NO_REDIRECT": value}}))
                self.args.environment_json = str(settings)
                self.assert_rejected("INVALID_BOOLEAN_ENV" if isinstance(value, str) else "ENV_VALUE_MUST_BE_STRING")

    def test_reviewed_recovery_environment_allowed_for_both_services(self):
        settings = self.root / "environment.json"
        reviewed = {"WHATSAPP_CRM_PUBLIC_URL": "https://wh.meludtech.tech", "AVA_OIDC_CLIENT_ID": "ava-web"}
        settings.write_text(json.dumps({service: reviewed for service in builder.SERVICES}))
        self.args.environment_json = str(settings)
        builder.build(self.args)
        for service in builder.SERVICES:
            self.assertEqual(self.manifest()["services"][service]["environment"], reviewed)

    def test_recovery_url_requires_exact_reviewed_value(self):
        for value in ("http://wh.meludtech.tech", "https://wh.meludtech.tech/", "https://evil.invalid",
                      "https://wh.meludtech.tech?token=SECRET_SENTINEL", "*", "https://*.meludtech.tech"):
            with self.subTest(value=value):
                settings = self.root / "environment.json"
                settings.write_text(json.dumps({"provisioning_worker": {"WHATSAPP_CRM_PUBLIC_URL": value}}))
                self.args.environment_json = str(settings)
                self.assert_rejected("INVALID_REVIEWED_ENV_VALUE")

    def test_recovery_client_requires_exact_reviewed_value(self):
        for value in ("admin-cli", "ava-other", "*", "ava-*", "ava-web ", "SECRET_SENTINEL"):
            with self.subTest(value=value):
                settings = self.root / "environment.json"
                settings.write_text(json.dumps({"whatsapp_crm": {"AVA_OIDC_CLIENT_ID": value}}))
                self.args.environment_json = str(settings)
                self.assert_rejected("INVALID_REVIEWED_ENV_VALUE")

    def test_secret_or_runtime_environment_keys_rejected(self):
        for key in ("PASSWORD", "API_TOKEN", "PORT", "AVA_IDENTITY_SECRET", "AVA_OIDC_CLIENT_SECRET",
                    "WHATSAPP_CRM_PUBLIC_URL_TOKEN", "AVA_PASSWORD_RECOVERY_NO_REDIRECT_TOKEN",
                    "AVA_PASSWORD_RECOVERY_UNKNOWN"):
            with self.subTest(key=key):
                settings = self.root / "environment.json"
                settings.write_text(json.dumps({"whatsapp_crm": {key: "true"}}))
                self.args.environment_json = str(settings)
                self.assert_rejected("ENV_KEY_NOT_AUTHORIZED")

    def test_boolean_environment_values_rejected(self):
        settings = self.root / "environment.json"
        settings.write_text(json.dumps({"whatsapp_crm": {"AVA_SELF_REGISTRATION_ENABLED": "SECRET SENTINEL"}}))
        self.args.environment_json = str(settings)
        self.assert_rejected("INVALID_BOOLEAN_ENV")

    def test_existing_bundle_not_overwritten(self):
        builder.build(self.args)
        manifest_bytes = (Path(self.args.output) / "manifest.json").read_bytes()
        with self.assertRaisesRegex(RuntimeError, "OUTPUT_ALREADY_EXISTS"):
            builder.build(self.args)
        self.assertEqual((Path(self.args.output) / "manifest.json").read_bytes(), manifest_bytes)

    def test_cli_does_not_echo_secret_input(self):
        settings = self.root / "environment.json"
        settings.write_text(json.dumps({"whatsapp_crm": {"PASSWORD": "DO_NOT_PRINT_SENTINEL"}}))
        args = ["python3", str(Path(builder.__file__))]
        for key in ("repo", "base_commit", "worker_base_commit", "candidate_commit", "crm_image", "worker_image", "migration_runner",
                    "contract_runner", "schema_json", "output"):
            args += ["--" + key.replace("_", "-"), getattr(self.args, key)]
        args += ["--environment-json", str(settings)]
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {"error": "ENV_KEY_NOT_AUTHORIZED"})
        self.assertNotIn("DO_NOT_PRINT_SENTINEL", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
