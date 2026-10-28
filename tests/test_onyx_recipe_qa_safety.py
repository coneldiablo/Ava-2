"""Safety and contract tests for the disposable Onyx recipe QA runner."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("run_onyx_recipe_qa", ROOT / "scripts/run-onyx-recipe-qa.py")
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)


class OnyxRecipeQaSafetyTests(unittest.TestCase):
    def test_initialize_uses_only_precreated_private_directory_and_catalogue(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory = Path(temporary), Path(temporary) / "onyx-recipe-qa-one"
            directory.mkdir(mode=0o700)
            catalogue = directory / "catalogue.json"
            catalogue.write_text("{}\n"); catalogue.chmod(0o600)
            with mock.patch.object(qa, "BASE", base), mock.patch.object(qa.os, "geteuid", return_value=0), \
                 mock.patch.object(qa.helper, "owned_path", side_effect=lambda path, **_: Path(path)), \
                 mock.patch.object(qa.helper, "private_json", return_value=(b"{}\n", {})), \
                 mock.patch.object(qa, "validate_catalogue", return_value={}), \
                 mock.patch.object(qa, "IMAGE_KEYS", ()), \
                 mock.patch.object(qa, "_capacity"):
                manifest = qa.initialize(directory, 911001)
            self.assertEqual(manifest["row"]["reservedMemoryMiB"], 12800)
            self.assertEqual(manifest["row"]["namespace"], "ava_" + manifest["row"]["id"].replace("-", ""))
            self.assertFalse(manifest["buyer_acceptance"]); self.assertFalse(manifest["rag_acceptance"])
            self.assertEqual(catalogue.read_text(), "{}\n")

    def test_scope_and_business_fail_closed_before_any_container_action(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            good = base / "onyx-recipe-qa-one"; good.mkdir(mode=0o700)
            with mock.patch.object(qa, "BASE", base), mock.patch.object(qa.os, "geteuid", return_value=0), \
                 mock.patch.object(qa.helper, "owned_path", side_effect=lambda path, **_: Path(path)), \
                 mock.patch.object(qa.helper, "run", side_effect=AssertionError("container action")):
                for directory, business in ((base / "wrong", 911001), (good, 911000)):
                    with self.subTest(directory=directory, business=business), self.assertRaises(ValueError):
                        qa.initialize(directory, business)

    def test_network_boundary_allows_only_gateway_on_fixed_external_networks(self):
        good = {'networks': {'native': {'internal': True},
                            'ingress': {'external': True, 'name': 'ava-module-ingress'},
                            'access': {'external': True, 'name': 'ava-module-access'}},
                'services': {'api': {'networks': ['native']}, 'worker': {'networks': ['native']},
                             'auth': {'networks': ['native']}, 'gateway': {'networks': ['native', 'ingress', 'access']}}}
        self.assertTrue(qa._runtime_networks_private(good))
        for mutate in [lambda c: c['services']['api'].update(networks=['native', 'access']),
                       lambda c: c['services']['auth'].update(networks=['native', 'ingress']),
                       lambda c: c['services']['gateway'].update(networks=['native', 'ingress', 'ingress']),
                       lambda c: c['networks']['native'].update(internal=False),
                       lambda c: c['networks']['access'].update(name='foreign'),
                       lambda c: c['networks'].update(host={})]:
            candidate = json.loads(json.dumps(good)); mutate(candidate)
            with self.subTest(candidate=candidate): self.assertFalse(qa._runtime_networks_private(candidate))
        self.assertTrue(qa._runtime_networks_private({'networks': {'native': {'internal': True}},
                                                    'services': {'api': {'networks': ['native']}}}))

    def test_capacity_includes_auth_gateway_and_twenty_percent_host_headroom(self):
        # This available-memory boundary would admit the old 12288 MiB
        # reservation, but fails after charging the missing auth/gateway 512.
        with mock.patch.object(qa.Path, 'read_text', return_value='MemTotal: 51200000 kB\nMemAvailable: 23000000 kB\n'):
            with self.assertRaisesRegex(ValueError, 'QA_CAPACITY_REQUIRED'): qa._capacity()
        with mock.patch.object(qa.Path, 'read_text', return_value='MemTotal: 51200000 kB\nMemAvailable: 24000000 kB\n'):
            qa._capacity()

    def test_initialize_rejects_catalogue_image_not_installed_at_exact_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "onyx-recipe-qa-one"; directory.mkdir(mode=0o700)
            image = "sha256:" + "a" * 64
            with mock.patch.object(qa, "_scope", return_value=directory), \
                 mock.patch.object(qa.helper, "private_json", return_value=(b"{}", {"backendImage": image})), \
                 mock.patch.object(qa, "validate_catalogue"), mock.patch.object(qa, "IMAGE_KEYS", ("backendImage",)), \
                 mock.patch.object(qa.helper, "run", return_value=json.dumps([{"Id": "sha256:" + "b" * 64}])):
                with self.assertRaisesRegex(ValueError, "INSTALLED_IMMUTABLE_IMAGE_REQUIRED"):
                    qa.initialize(directory, 911001)

    def test_source_has_closed_phases_no_publish_or_destructive_stop(self):
        source = (ROOT / "scripts/run-onyx-recipe-qa.py").read_text()
        self.assertIn('PHASES = ("prepare", "launch", "dependencies", "embeddings", "repeat", "stop")', source)
        self.assertIn("BUSINESSES = (911001, 911002)", source)
        self.assertNotRegex(source, r"['\"](?:-p|--publish|--privileged)['\"]")
        self.assertNotIn("/var/run/docker.sock", source)
        self.assertNotIn('"down"', source); self.assertNotIn('"--volumes"', source)
        self.assertIn('"volumes_retained": True', source)
        self.assertIn("input=SEARCH_PROBE", source)
        self.assertIn("input=EMBEDDING_PROBE", source)
        self.assertIn("nomic-ai/nomic-embed-text-v1", qa.EMBEDDING_PROBE)
        self.assertIn("/encoder/bi-encoder-embed", qa.EMBEDDING_PROBE)
        self.assertIn("'inference_model','indexing_model'", qa.EMBEDDING_PROBE)
        self.assertIn('"admin", "info", "runtime"', source)

    def test_result_contract_never_claims_rag_or_buyer_acceptance(self):
        tree = ast.parse((ROOT / "scripts/run-onyx-recipe-qa.py").read_text())
        strings = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        self.assertIn("buyer_acceptance", strings); self.assertIn("rag_acceptance", strings)
        self.assertIn("health_is_not_rag_acceptance", strings)
        self.assertIn("embedding_health_is_not_rag_acceptance", strings)

    def test_embedding_probe_accepts_only_safe_checks_and_numeric_diagnostics(self):
        checks = {name: True for name in ("three_vectors", "dimension_768", "all_finite",
                                           "distinct_text_vectors", "repeat_stable", "health_after_model_load")}
        diagnostics = {"dimension": 768, "vector_count": 3, "finite_value_count": 2304,
                       "distinct_l2": 0.5, "repeat_max_abs_delta": 0.0, "latency_ms": 1234}
        output = json.dumps({name: {"checks": checks, "diagnostics": diagnostics}
                             for name in ("inference_model", "indexing_model")})
        completed = mock.Mock(returncode=0, stdout=output)
        with mock.patch.object(qa.subprocess, "run", return_value=completed) as run:
            accepted, safe = qa._embedding_probe(Path("/safe/recipe"), {"namespace": "ava_" + "a" * 32})
        self.assertEqual(len(accepted), 12); self.assertTrue(all(accepted.values()))
        self.assertEqual(set(safe), {"inference_model", "indexing_model"})
        command = run.call_args.args[0]
        self.assertNotIn("--network", command); self.assertNotIn("--publish", command)
        self.assertEqual(run.call_args.kwargs["input"], qa.EMBEDDING_PROBE)
        self.assertEqual(run.call_args.kwargs["timeout"], 660)

    def test_embedding_probe_rejects_vectors_or_nonfinite_diagnostics_in_output(self):
        bad = {name: {"checks": {"three_vectors": True}, "diagnostics": {"vectors": [1.0]}}
               for name in ("inference_model", "indexing_model")}
        completed = mock.Mock(returncode=0, stdout=json.dumps(bad))
        with mock.patch.object(qa.subprocess, "run", return_value=completed), \
             self.assertRaisesRegex(ValueError, "QA_EMBEDDING_PROBE_FAILED"):
            qa._embedding_probe(Path("/safe/recipe"), {"namespace": "ava_" + "a" * 32})

    def test_stop_targets_only_validated_project_and_retains_volumes(self):
        deployment = "12345678-1234-4123-8123-123456789abc"
        row = {"id": deployment, "businessId": 911001, "module": "onyx", "revision": 1,
               "hostname": "qa-12345678-911001.knowledge.meludtech.tech",
               "namespace": "ava_" + deployment.replace("-", ""), "sourceCommit": qa.helper.PINNED["onyx"],
               "reservedMemoryMiB": 12288}
        manifest = {"qa_only": True, "buyer_acceptance": False, "rag_acceptance": False, "row": row,
                    "payload": {"deploymentId": deployment, "businessId": 911001, "revision": 1,
                                "leaseToken": "22345678-1234-4123-8123-123456789abc"}}
        launcher = mock.Mock(); launcher._recipe.return_value = (Path("/safe/recipe"), {}, {})
        factory = mock.Mock()
        with mock.patch.object(qa, "_scope", side_effect=lambda path: path), \
             mock.patch.object(qa, "_load_manifest", return_value=manifest), \
             mock.patch.object(qa, "OnyxRecipeFactory", return_value=factory), \
             mock.patch.object(qa.helper, "Deployments", return_value=launcher), \
             mock.patch.object(qa, "Heartbeat") as heartbeat, \
             mock.patch.object(qa.helper, "run", return_value="") as run, \
             mock.patch.object(qa, "_private_new"):
            heartbeat.return_value.__enter__.return_value = heartbeat.return_value
            result = qa.execute(Path("/safe/qa"), "stop")
        command = run.call_args.args[0]
        launcher._state.assert_called_once_with(row, {})
        self.assertEqual(command[-3:], ["stop", "--timeout", "15"])
        self.assertNotIn("down", command); self.assertNotIn("--volumes", command)
        self.assertTrue(result["checks"]["volumes_retained"])


if __name__ == "__main__": unittest.main()
