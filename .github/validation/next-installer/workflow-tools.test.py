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

    def test_absent_uninstaller_cannot_be_executed_again_after_registration_failure(self):
        installer = (Path(__file__).parent / 'windows-installer.ps1').read_text()
        section = installer.split('function Uninstall-Actual', 1)[1].split('function Command-Worker', 1)[0]
        gone = section.index("if (Test-Path -LiteralPath $install) { throw")
        disowned = section.index('$script:installedAttested = $false')
        failure = section.index("if ($uninstallRemained -or $protocolRemained) { throw")
        self.assertLess(gone, disowned)
        self.assertLess(disowned, failure)
        self.assertEqual(section.count('$script:installedAttested = $false'), 1)
        self.assertIn("if ($installedAttested) { Uninstall-Actual 'failure-cleanup-uninstall' }", installer)

    def test_uninstall_summary_is_checked_out_parsed_and_retained_without_raw_registry_values(self):
        directory = Path(__file__).parent
        workflow = (directory.parents[1] / 'workflows' / 'next-context-menu-validation.yml').read_text()
        installer = (directory / 'windows-installer.ps1').read_text()
        summary = (directory / 'uninstall-registration-summary.ps1').read_text()
        self.assertIn('.github/validation/next-installer', workflow)
        self.assertIn('Get-ChildItem control/.github/validation/next-installer/*.ps1', workflow)
        self.assertIn('dsh-reuse-installation/*.json', workflow)
        self.assertIn("'uninstall-registration-summary.ps1'", installer)
        self.assertIn("'-protocol-after-uninstall.json'", installer)
        self.assertIn('protocolCommandMatchesOwnedExe=', summary)
        self.assertNotIn('command=$', summary)
        self.assertNotIn('value=$', summary)
        self.assertNotIn('DeleteSubKey', summary)
        self.assertNotIn('SetValue', summary)


if __name__ == '__main__':
    unittest.main()
