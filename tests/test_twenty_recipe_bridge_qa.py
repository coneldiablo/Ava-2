"""Receipt validation tests, explicitly not native gateway acceptance."""
import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('recipe_bridge_qa', ROOT / 'scripts/run-twenty-recipe-bridge-qa.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def receipt():
    return {'qa_only':True,'business_id':900011,'checks':sorted(qa.CHECKS),
            'identity_enrollment':'real_invitation_store_without_keycloak',
            'transport':'private_http_no_tls','second_twenty_deployment':False,'production_access':False}


def test_only_complete_scoped_receipt_is_admitted():
    valid = receipt()
    assert qa.safe_receipt(valid, 900011) == valid
    assert qa.safe_receipt(valid, 900012) is None
    for fields in ({'checks':['AVA_BUSINESS_SCOPE']*20}, {'checks':[{}]*20}, {'checks':[]},
                   {'production_access':True}, {'transport':'https'}, {'qa_only':1},
                   {'secret':'Bearer do-not-persist'}, {'identity_enrollment':'password=do-not-persist'}):
        assert qa.safe_receipt({**valid, **fields}, 900011) is None


def test_partial_or_non_receipt_library_output_is_not_evidence():
    for value in (None, [], 'secret', {'checks':['SECRET']}, {'error_code':'FAILURE'}):
        assert qa.safe_receipt(value,900011) is None
