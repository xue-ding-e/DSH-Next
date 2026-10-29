import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const sha256 = value => createHash('sha256').update(value).digest('hex')

test('full qualification restores the reviewed smoke, two real versions, PE and installer stages without changing their acceptance', () => {
  const driver = read('./windows-qualify.ps1')
  const retained = driver.slice(driver.indexOf('    $smokeReport ='))
  // This is the complete unchanged suffix of reviewed Cw4, not the diagnostic-only driver.
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

test('full qualification retains exactly the native ownership and signed-tool controls exercised by run 40821386036', () => {
  const expected = {
    'windows-owned-process.ps1': '142cdaf8a410286000b2e5c487e6ca1c4d1ea35cdf39ae77aff8d726a068023a',
    'windows-owned-process.test.ps1': 'ee4cc01b796e9d27558e7e981df35b179c80b667ef897ce5efe6b84443bf6bcb',
    'windows-vctip-policy.ps1': '70d19ba8c6a15704b7173c60b14c3b10aad383625512c9a67c12c9d9ac113dad',
    'vctip-policy.test.mjs': '429834e7605218b0c3de6615bd3b5619ae3dce2caf3ae50965cdd25e192eb26f',
  }
  for (const [name, expectedHash] of Object.entries(expected)) assert.equal(sha256(read(`./${name}`)), expectedHash)
})

test('only the explicitly reviewed full lane can package and only Desktop opts into compiler tool teardown', () => {
  const driver = read('./windows-qualify.ps1')
  const manifest = JSON.parse(read('./manifest.json'))
  const workflow = read('../../workflows/next-context-menu-validation.yml')
  assert.equal(manifest.diagnosticOnly, false)
  assert.equal(manifest.version, '0.2.1-rc.3.20261029.1')
  assert.equal(manifest.upgradeVersion, '0.2.1-rc.3.20261029.2')
  assert.match(driver, /ValidateSet\('install-dependencies','qualify'\)/u)
  assert.match(driver, /if \(\$m\.diagnosticOnly -ne \$false\) \{ throw/u)
  assert.match(driver, /if \(\$Label -cne 'desktop-tests'\) \{ throw/u)
  assert.equal(driver.match(/1200 \$vctipPolicy/gu)?.length, 1)
  assert.equal(driver.match(/New-NextVerifiedVctipPolicy/gu)?.length, 1)
  assert.doesNotMatch(driver, /diagnostic-policy|Mode diagnose/u)
  assert.match(workflow, /needs: linux_qualification/u)
  assert.match(workflow, /timeout-minutes: 360/u)
  assert.match(workflow, /windows-qualify\.ps1 -Product product -Mode qualify/u)
  assert.doesNotMatch(workflow, /contents: write|matrix:|workflow_call:|pull_request:|\n  push:/u)
})
