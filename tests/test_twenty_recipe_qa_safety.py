"""Static/unit safety checks for disposable Twenty recipe QA runner."""
import ast
import importlib.util
import inspect
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("run_twenty_recipe_qa", ROOT / "scripts/run-twenty-recipe-qa.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class TwentyRecipeQaSafetyTests(unittest.TestCase):
    def test_initialize_rejects_unapproved_business_and_mutable_image_before_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(qa, "BASE", Path(tmp)):
                for business, image in [(900010, "sha256:" + "a" * 64), (900011, "repo/twenty:latest")]:
                    with self.subTest(business=business, image=image), mock.patch.object(qa.helper, "run", side_effect=AssertionError("Docker called")):
                        with self.assertRaises(ValueError): qa.initialize(Path(tmp) / "twenty-recipe-qa-x", image, business)

    def test_runner_source_has_no_published_ports_and_uses_qa_businesses_only(self):
        source = (ROOT / "scripts/run-twenty-recipe-qa.py").read_text()
        self.assertNotRegex(source, r"['\"](?:-p|--publish|ports)['\"]")
        self.assertIn("business not in (900011, 900012)", source)
        self.assertIn("startswith('twenty-recipe-qa-')", source)
        self.assertIn("qa_only': True", source)

    def test_result_contract_explicitly_does_not_claim_buyer_acceptance(self):
        tree = ast.parse((ROOT / "scripts/run-twenty-recipe-qa.py").read_text())
        values = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant)]
        self.assertIn("buyer_acceptance", values)
        self.assertIn("health_not_buyer_acceptance", values)
        self.assertIn(False, values)

    def test_execute_constructor_supports_recipe_factory_in_deployment_helper(self):
        # The runner injects the fixed factory so QA cannot silently select a
        # customer-provided recipe; this API contract must remain available.
        self.assertIn("recipe_factory", inspect.signature(qa.helper.Deployments).parameters)


if __name__ == "__main__":
    unittest.main()
