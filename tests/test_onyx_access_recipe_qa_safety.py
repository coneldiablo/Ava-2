"""Unit contract tests; these fixtures do not attest a native login."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('onyx_access_recipe_qa', ROOT / 'scripts/run-onyx-access-recipe-qa.py')
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)


class OnyxAccessRecipeQaSafetyTests(unittest.TestCase):
    def test_exact_bounded_receipt_contains_only_checks_and_identity(self):
        row = {'businessId': 911001, 'id': '430d9409-92a2-4610-beaa-ed4cc3209612'}
        receipt = {'business_id': row['businessId'], 'deployment_id': row['id'],
                   'checks': {key: True for key in qa.CHECKS}}
        self.assertEqual(qa.check_receipt(json.dumps(receipt), row), receipt)
        bad = [{**receipt, 'business_id': 911002}, {**receipt, 'business_id': True},
               {**receipt, 'deployment_id': 'foreign'}, {**receipt, 'token': 'redact'},
               {**receipt, 'checks': {}}, {**receipt, 'checks': {**receipt['checks'], 'extra': True}}]
        bad += [{**receipt, 'checks': {**receipt['checks'], key: False}} for key in qa.CHECKS]
        for candidate in bad:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                qa.check_receipt(json.dumps(candidate), row)
        for raw in ('x' * 8193, '', '[]', 'null'):
            with self.subTest(raw=raw[:10]), self.assertRaises(ValueError): qa.check_receipt(raw, row)

    def test_legacy_recipe_is_not_claimed_to_have_native_access(self):
        with mock.patch.object(qa.qa, '_scope', side_effect=lambda value: value), \
             mock.patch.object(qa.qa, '_load_manifest', return_value={'row': {'reservedMemoryMiB': 12288}, 'payload': {}}), \
             mock.patch.object(qa.helper, 'Deployments') as deployments:
            with self.assertRaisesRegex(ValueError, 'QA_ACCESS_RECIPE_REQUIRED'): qa.execute(Path('/isolated'))
            deployments.assert_not_called()

    def test_probe_only_uses_real_http_and_never_returns_credentials_or_cookies(self):
        compile(qa.PROBE, 'native_access_probe', 'exec')
        self.assertIn('http://127.0.0.1:4011/v1/reconcile', qa.PROBE)
        self.assertIn("'http://gateway:4080/ava-auth/start'", qa.PROBE)
        self.assertIn("'http://api:8080/me'", qa.PROBE)
        self.assertIn('ProxyHandler({})', qa.PROBE)
        self.assertNotIn('ASGITransport', qa.PROBE)
        self.assertNotIn('verify=False', qa.PROBE)
        printed = qa.PROBE.split('print(json.dumps(', 1)[1]
        self.assertNotIn('worker', printed); self.assertNotIn('cookie', printed)
        self.assertNotIn('headers', printed); self.assertNotIn('own_raw', printed)
        source = (ROOT / 'scripts/run-onyx-access-recipe-qa.py').read_text()
        self.assertNotIn("'--publish'", source); self.assertNotIn("'--privileged'", source)
        self.assertIn("'buyer_acceptance': False", source)
        self.assertIn("'keycloak_browser_tls_accepted': False", source)
