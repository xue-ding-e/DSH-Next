import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const sha256 = value => createHash('sha256').update(value).digest('hex')

test('full qualification restores the reviewed smoke, two real versions, PE and installer stages without changing their acceptance', () => {
  const driver = read('./windows-qualify.ps1')
  const retained = driver.slice(driver.indexOf('    $smokeReport ='))
    .replace("        $packageToolPolicy = New-NextVerifiedVctipPolicy -WorkingDirectory $Product -EvidenceDirectory $evidence -Scope $label\n        try {\n", '')
    .replace(" $packageToolPolicy\n        } finally { $packageToolPolicy.FileLock.Dispose() }", '')
    .replace('        Save-NextUnqualifiedInstaller -Product $Product -Label $label\n', '')
  // Apart from the explicit per-command tool-policy wrapper, this is the complete reviewed Cw4 suffix.
  const assertRestored = value => assert.equal(sha256(value), '563d27b291d86aba26dce80839e5e8d935ffd06a4486dda41f4b1b10d921038b')
  assertRestored(retained)
  for (const changed of [retained.replace('package:next:win:x64', 'package:win:x64'),
    retained.replace("smoke-test-report $Product", "test-report $Product"),
    retained.replace('qualified=($null -eq $failure)', 'qualified=$true')]) {
    assert.notEqual(changed, retained)
    assert.throws(() => assertRestored(changed))
  }
  assert.match(retained, /stages=\$stages\.ToArray\(\)/u)
  assert.match(driver, /\$stages\.Add\(@\{ label=\$Label; arguments=\$Arguments; result=\$result \}\)/u)
})

test('the actual-tested ownership predicate, cumulative-member checks and exact-handle termination remain unchanged', () => {
  const owner=read('./windows-owned-process.ps1')
  const predicate=owner.slice(owner.indexOf('    public static bool IsToolCandidate('), owner.indexOf('    // Diagnostic only:'))
  const checks=owner.slice(owner.indexOf('    static ACCOUNTING Accounting('), owner.indexOf('    static bool CleanupVerifiedTool('))
  const action=owner.slice(owner.indexOf('        var evidence=new ToolCleanup {'), owner.indexOf('    static void Check('))
  assert.equal(sha256(predicate + checks + action), 'da2e42139834edaf850995c403f209f1adb9186eba5601225ba5d09ea3c5fcfd')
})

test('only the explicitly reviewed full lane can package and only its three compiler commands opt into tool teardown', () => {
  const driver = read('./windows-qualify.ps1')
  const manifest = JSON.parse(read('./manifest.json'))
  const workflow = read('../../workflows/next-context-menu-validation.yml')
  assert.equal(manifest.diagnosticOnly, false)
  assert.equal(manifest.version, '0.2.1-rc.3.20261029.1')
  assert.equal(manifest.upgradeVersion, '0.2.1-rc.3.20261029.2')
  assert.match(driver, /ValidateSet\('install-dependencies','qualify'\)/u)
  assert.match(driver, /if \(\$m\.diagnosticOnly -ne \$false\) \{ throw/u)
  assert.match(driver, /if \(\$Label -cnotin @\('desktop-tests','package-v1','package-v2'\)\) \{ throw/u)
  assert.equal(driver.match(/1200 \$vctipPolicy/gu)?.length, 1)
  assert.equal(driver.match(/New-NextVerifiedVctipPolicy/gu)?.length, 2)
  assert.equal(driver.match(/Run-Pnpm \$label[^\n]* \$packageToolPolicy/gu)?.length, 1)
  assert.doesNotMatch(driver, /diagnostic-policy|Mode diagnose/u)
  assert.match(workflow, /needs: linux_qualification/u)
  assert.match(workflow, /timeout-minutes: 360/u)
  assert.match(workflow, /windows-qualify\.ps1 -Product product -Mode qualify/u)
  assert.doesNotMatch(workflow, /contents: write|matrix:|workflow_call:|pull_request:|\n  push:/u)
})

test('path guarding uses internal extended DOS paths without admitting external namespaces or swallowing native failures', () => {
  const guard = read('./windows-path-guard.ps1')
  const fixture = read('./windows-path-guard.test.ps1')
  assert.match(guard, /Path\.GetFullPath\(LocalDrivePath\(path\)\)/u)
  assert.match(guard, /GetFileAttributes\(NativePath\(cursor\)\)/u)
  assert.match(guard, /CreateFile\(NativePath\(existing\),0x80,7,IntPtr.Zero,3,0x02200000/u)
  assert.match(guard, /error!=2 && error!=3/u)
  assert.match(guard, /if \(mustExist && cursor==full\) throw NativeFailure/u)
  assert.match(guard, /if \(\(attributes & 0x400\)!=0\) throw/u)
  assert.match(guard, /utf16Length=.*path\.Length.*win32Error=/u)
  assert.doesNotMatch(guard, /File\.Exists|Directory\.Exists|LongPathsEnabled/u)
  for (const proof of ['NextRawPathObservation', 'Require-Missing', '$staleInventory', '$missingParent', '$longDangling', '$longLink', '$sibling', 'Assert-NextInstallTree']) assert.ok(fixture.includes(proof), proof)
  assert.match(fixture, /longDirectory\.Length -lt 340/u)
  assert.match(fixture, /Ca missing-path cause remains unproven/u)
})


test('quarantine is a locked exact-file diagnostic copy, never a qualified package index or install input', () => {
  const helper = read('./windows-quarantine.ps1')
  const driver = read('./windows-qualify.ps1')
  const workflow = read('../../workflows/next-context-menu-validation.yml')
  assert.match(helper, /ValidateSet\('package-v1','package-v2',IgnoreCase=\$false\)/u)
  assert.match(helper, /\[IO\.FileShare\]::Read\)/u)
  assert.match(helper, /\$signature\.Status -ne 'NotSigned'/u)
  assert.match(helper, /\$sourceHash -cne \$copyHash/u)
  assert.match(helper, /\$copied -ne \$bytes/u)
  assert.match(helper, /\$bytes -gt 2147483648/u)
  assert.match(helper, /\$timer\.Elapsed\.TotalSeconds -gt 120/u)
  assert.match(helper, /qualified=\$false; installAuthorized=\$false; publishAuthorized=\$false/u)
  assert.equal((helper.match(/\[IO\.FileMode\]::CreateNew/gu) ?? []).length, 2)
  assert.doesNotMatch(helper, /packages\.json|\$packages\.Add|Invoke-NextOwnedProcess|Start-Process|Get-ChildItem|Recurse/u)
  const quarantineCall = 'Save-NextUnqualifiedInstaller -Product $Product -Label $label'
  assert.equal(driver.split(quarantineCall).length, 2)
  assert.ok(driver.indexOf("Expected an explicitly unsigned installer.") < driver.indexOf(quarantineCall))
  assert.ok(driver.indexOf(quarantineCall) < driver.indexOf('Assert-NextInstallTree -Path $output'))
  const upload = workflow.slice(workflow.indexOf('      - name: Preserve exact unqualified NSIS'), workflow.indexOf('      - name: Retain only generated'))
  assert.match(upload, /name: next-unqualified-quarantine-/u)
  assert.equal((upload.match(/dsh-next-installer-quarantine\/package-v[12]-unqualified\.(?:exe|json)/gu) ?? []).length, 4)
  assert.doesNotMatch(upload, /\.partial|\*|product\/|windows\//u)
})
