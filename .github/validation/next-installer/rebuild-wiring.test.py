"""Static wiring regressions; native PS/NSIS and lifecycle remain CI obligations."""
import json
from pathlib import Path
import unittest
D=Path(__file__).parent
class Wiring(unittest.TestCase):
 def test_sealed_sources_and_only_new_version_built(self):
  m=json.loads((D/'manifest.json').read_text())
  self.assertEqual(m['source'],'6b9ebe026a565e5aa547811972dff745961e134f')
  self.assertEqual(m['baselineSource'],'270dd45091805cb504fdd39bf09d9ec596ca4150')
  s=(D/'windows-qualify.ps1').read_text()
  self.assertIn('$versions = @($m.upgradeVersion)',s)
  self.assertNotIn('$versions +=',s)
  self.assertIn("$label = 'package-v2'",s)
  self.assertIn('$packages.Add($baseline[0])',s)
  self.assertIn('Old V2 bytes cannot stand in for the fixed source',s)
  self.assertIn('buildQualified=($null -eq $failure); qualified=$false',s)
 def test_baseline_entire_archive_verified_before_extract(self):
  s=(D/'verify-reuse.py').read_text()
  self.assertLess(s.index('result = verify_archive(m, a.archive)'),s.index('extract_inputs(m, a.archive, a.output)'))
  self.assertIn("digest(f) == m['artifactSha256']",s)
  self.assertIn('for i in z.infolist():',s)
  self.assertIn("m['files'][i.filename]['sha256']",s)
  m=json.loads((D/'reuse-manifest.json').read_text())
  self.assertEqual(len(m['files']),106);self.assertEqual(len(m['extractFiles']),3)
 def test_all_view_and_foreign_gate_do_not_relax_normal_uninstall(self):
  s=(D/'windows-installer.ps1').read_text()
  self.assertIn("$allViews.Count -ne 4",s)
  self.assertIn("$Label -cne 'foreign-handler-uninstall'",s)
  self.assertIn("elseif ($uninstallRemained -or $protocolRemained) { throw",s)
  self.assertIn("if ((Json (Read-Registry $nextProtocol)) -cne $script:foreignProtocolSnapshot) { throw",s)
  self.assertIn("Install-Actual 'reinstall-idempotent' $final",s)
  self.assertIn('-Source $Package.source',s)
 def test_exact_source_linux_prerequisite_runs_before_any_build_or_installer(self):
  m=json.loads((D/'manifest.json').read_text());p=m['linuxQualification']
  self.assertEqual(p['runId'],41132362963);self.assertEqual(p['control'],'71d391a9ccad1457786fdcae4de174bad95e80d1')
  self.assertEqual(p['reviewedContents']['actualStagesPassed'],15)
  s=(D.parents[1]/'workflows/next-context-menu-validation.yml').read_text()
  gate=s.index('node control/.github/validation/next-installer/linux-evidence.mjs')
  self.assertLess(gate,s.index('Download fixed prior artifact'))
  self.assertLess(gate,s.index('Test fixed source and build only new V2'))
  self.assertIn('linux-evidence.test.mjs',s);self.assertIn('linux-dependency/reviewed-linux.json',s)
 def test_no_release_or_product_write_credentials(self):
  s=(D.parents[1]/'workflows/next-context-menu-validation.yml').read_text()
  self.assertIn('contents: read',s);self.assertIn('actions: read',s)
  self.assertNotIn('contents: write',s);self.assertNotIn('gh release',s)
  self.assertEqual(s.count('GH_TOKEN: ${{ github.token }}'),1)
  self.assertIn('timeout-minutes: 240',s)
  self.assertIn('timeout-minutes: 180',s)
  self.assertIn('timeout-minutes: 25',s)
if __name__=='__main__':unittest.main()
