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
