"""Guard against PowerShell Get-Command returning several installed applications."""
from pathlib import Path
import unittest


class ToolSelection(unittest.TestCase):
    def test_each_native_tool_selects_one_application_before_reading_source(self):
        workflow = (Path(__file__).parents[2] / 'workflows' / 'next-context-menu-validation.yml').read_text()
        for tool in ['python', 'gh', 'node']:
            with self.subTest(tool=tool):
                self.assertEqual(workflow.count(f'(Get-Command {tool}.exe -CommandType Application | Select-Object -First 1).Source'), 1)
                self.assertNotIn(f'(Get-Command {tool}.exe -CommandType Application).Source', workflow)


if __name__ == '__main__':
    unittest.main()
