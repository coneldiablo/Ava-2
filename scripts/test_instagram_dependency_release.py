import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('overlay', Path(__file__).with_name('call-product-recovery-release.py'))
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)

class DependencyReleaseTests(unittest.TestCase):
    def test_only_pinned_crm_wheel_installed_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wheel = root / 'dependencies/instagrapi-3.0.21-py3-none-any.whl'
            wheel.parent.mkdir(); wheel.write_bytes(b'reviewed-wheel')
            context = root / 'context'; context.mkdir()
            manifest = {'roles': ['crm'], 'instagramDependency': {
                'version': '3.0.21', 'sourceCommit': '3f0b4369753fc69d98cd2bc853146cc85d3b1635',
                'wheel': str(wheel.relative_to(root)), 'sha256': op.digest(wheel)}}
            lines = op.instagram_dependency(root, manifest, 'crm', context)
            self.assertEqual((context / 'instagrapi.whl').read_bytes(), wheel.read_bytes())
            self.assertIn('--no-index --no-deps', lines[1])
            self.assertIn('pip check', lines[1])
            self.assertEqual(op.instagram_dependency(root, manifest, 'engine', context), [])
            for key, value in [('version', 'latest'), ('sourceCommit', 'other'),
                               ('wheel', '../outside.whl'), ('sha256', 'incorrect')]:
                invalid = copy.deepcopy(manifest); invalid['instagramDependency'][key] = value
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    op.instagram_dependency(root, invalid, 'crm', context)
            manifest['roles'] = ['crm', 'worker']
            with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_ROLE_SCOPE'):
                op.instagram_dependency(root, manifest, 'crm', context)

if __name__ == '__main__': unittest.main()
