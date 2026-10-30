import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('verifier', HERE / 'verify-reuse.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
M = json.loads((HERE / 'reuse-manifest.json').read_text())


def metadata():
    run = dict(id=M['priorRun'], run_attempt=1, head_sha=M['priorControl'],
               head_branch=M['priorBranch'], event='workflow_dispatch', status='completed',
               conclusion='failure', workflow_id=400043182,
               path='.github/workflows/next-context-menu-validation.yml',
               repository=dict(id=M['repositoryId'], full_name=M['repository']))
    artifact = dict(id=M['artifactId'], name=M['artifactName'], size_in_bytes=M['artifactBytes'],
                    expired=False, digest='sha256:' + M['artifactSha256'],
                    workflow_run=dict(id=M['priorRun'], repository_id=M['repositoryId'],
                                      head_repository_id=M['repositoryId'], head_sha=M['priorControl']))
    return run, artifact


def inventory():
    infos = []
    for n, f in M['files'].items():
        i = zipfile.ZipInfo(n)
        i.file_size = f['bytes']
        infos.append(i)
    return infos


class Pins(unittest.TestCase):
    def test_exact_failed_prior_run_is_only_reusable_not_qualified(self):
        v.validate_metadata(M, *metadata())
        self.assertTrue(M['executionAuthorized'])

    def test_metadata_wrong_identity_attempt_digest_status_fails(self):
        for owner, key, value in [('r', 'id', 1), ('r', 'run_attempt', 2),
                                  ('r', 'head_sha', '0' * 40), ('r', 'head_branch', 'main'),
                                  ('r', 'event', 'push'), ('r', 'status', 'in_progress'),
                                  ('r', 'conclusion', 'success'), ('r', 'workflow_id', 1),
                                  ('r', 'path', 'other'), ('a', 'id', 1), ('a', 'name', 'other'),
                                  ('a', 'size_in_bytes', 0), ('a', 'expired', True), ('a', 'digest', 'wrong')]:
            with self.subTest(owner=owner, key=key):
                r, a = metadata()
                (r if owner == 'r' else a)[key] = value
                with self.assertRaises(ValueError):
                    v.validate_metadata(M, r, a)
        for key in ['id', 'repository_id', 'head_repository_id', 'head_sha']:
            r, a = metadata(); a['workflow_run'][key] = 'wrong'
            with self.assertRaises(ValueError): v.validate_metadata(M, r, a)
        r, a = metadata(); r['repository']['id'] = 1
        with self.assertRaises(ValueError): v.validate_metadata(M, r, a)

    def test_full_inventory_and_five_selected_inputs(self):
        v.validate_inventory(M, inventory())

    def test_duplicate_missing_size_link_and_traversal_fail(self):
        for kind in ['duplicate', 'missing', 'size', 'link', 'traversal']:
            with self.subTest(kind=kind):
                infos = inventory(); m = copy.deepcopy(M)
                if kind == 'duplicate': infos.append(infos[0])
                if kind == 'missing': infos.pop()
                if kind == 'size': infos[0].file_size += 1
                if kind == 'link': infos[0].external_attr = 0o120777 << 16
                if kind == 'traversal':
                    old = infos[0].filename; infos[0].filename = '../escape'
                    m['files']['../escape'] = m['files'].pop(old)
                with self.assertRaises(ValueError): v.validate_inventory(m, infos)

    def test_cli_is_disabled_before_any_metadata_source_or_archive_read(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'disabled.json'
            disabled = copy.deepcopy(M)
            disabled['executionAuthorized'] = False
            manifest.write_text(json.dumps(disabled))
            args = [sys.executable, '-B', str(HERE / 'verify-reuse.py'), '--manifest', str(manifest)]
            for name in ['archive', 'run', 'artifact', 'product', 'output']:
                args += ['--' + name, 'DO-NOT-ACCESS-PENDING']
            r = subprocess.run(args, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('Pending user actions:read approval', r.stderr)
        self.assertNotIn('FileNotFoundError', r.stderr)


if __name__ == '__main__': unittest.main()
