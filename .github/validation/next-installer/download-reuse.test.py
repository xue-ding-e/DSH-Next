import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('download-reuse.py'))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class Fetch(unittest.TestCase):
    def run_case(self, payload, returncode=0, alive=False, limit=100, clock=(0, 0), stderr=b''):
        class Child:
            def poll(self):
                return None if alive else returncode
        child = Child()
        child.returncode = returncode
        def start(argv, **kwargs):
            self.assertEqual(argv, ['gh.exe', 'api', '--hostname', 'github.com', 'fixed-endpoint'])
            self.assertFalse(kwargs['shell'])
            kwargs['stdout'].write(payload)
            kwargs['stdout'].flush()
            kwargs['stderr'].write(stderr)
            kwargs['stderr'].flush()
            return child
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'artifact.zip'
            with patch.object(transport.subprocess, 'Popen', start), patch.object(transport.time, 'monotonic', side_effect=clock):
                transport.fetch(Path('gh.exe'), 'fixed-endpoint', target, limit, 5)
            self.assertEqual(target.read_bytes(), payload)

    def test_binary_bytes_are_written_to_exclusive_file_not_decoded(self):
        self.run_case(b'PK\x00\xff\x81')

    def test_nonzero_exit_and_empty_output_fail(self):
        for payload, code in [(b'partial', 1), (b'', 0)]:
            with self.assertRaises(RuntimeError):
                self.run_case(payload, code)

    def test_live_oversized_transfer_stops_without_launching_another_process(self):
        with self.assertRaisesRegex(RuntimeError, 'budget'):
            self.run_case(b'oversized', alive=True, limit=1)

    def test_live_timeout_stops_and_requires_outer_owner_cleanup(self):
        with self.assertRaisesRegex(RuntimeError, 'budget'):
            self.run_case(b'partial', alive=True, clock=(0, 6))

    def test_stderr_budget_is_enforced_for_live_and_finished_transfers(self):
        for alive in [False, True]:
            with self.assertRaises(RuntimeError):
                self.run_case(b'partial', alive=alive, stderr=b'x' * (1024 * 1024 + 1))

    def test_existing_download_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'artifact.zip'
            target.write_bytes(b'existing')
            with patch.object(transport.subprocess, 'Popen') as popen:
                with self.assertRaises(FileExistsError):
                    transport.fetch(Path('gh.exe'), 'fixed-endpoint', target, 100, 5)
                popen.assert_not_called()
            self.assertEqual(target.read_bytes(), b'existing')


if __name__ == '__main__':
    unittest.main()
