import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the only production opt-in is Desktop, using a locked Microsoft signature and official toolset preflight', () => {
  const policy = read('./windows-vctip-policy.ps1'), driver = read('./windows-qualify.ps1')
  assert.match(policy, /Get-AuthenticodeSignature -LiteralPath \$Path/u)
  assert.match(policy, /\$Status -ne 'Valid' -or \$Publisher -cne 'Microsoft Corporation'/u)
  assert.match(policy, /FileShare\]::Read\)\n    try \{\n        \$signature = Get-NextMicrosoftSignature/u)
  assert.match(policy, /Microsoft\.VCToolsVersion\.default\.txt/u); assert.match(policy, /\/bin\/Hostx64\/x64\/vctip\.exe/u)
  assert.match(policy, /Invoke-NextOwnedProcess -FilePath \$where[^\n]*-TimeoutSeconds 30/u)
  assert.match(driver, /if \(\$Label -cne 'desktop-tests'\)/u)
  assert.match(driver, /1200 \$vctipPolicy\n    \} finally \{ \$vctipPolicy\.FileLock\.Dispose\(\) \}/u)
  assert.doesNotMatch(policy + driver, /SetEnvironmentVariable|Set-ItemProperty|Remove-Item|taskkill/iu)
})
test('native teardown retains exact-handle checks, natural grace, distinct active cleanup evidence and failing ordinary descendants', () => {
  const owner = read('./windows-owned-process.ps1'), native = read('./windows-owned-process.test.ps1')
  assert.match(owner, /OpenProcess\(0x00101001,false,candidate\.pid\)/u)
  assert.match(owner, /SameOwnedHandle\(terminating,job,candidate\.pid,candidate\.created,expectedPath\)/u)
  assert.match(owner, /!UniqueMember\(job,candidate\.pid,baselineTotal\)/u)
  assert.match(owner, /TerminateProcess\(terminating,125\)/u)
  assert.match(owner, /rootExitGraceExceeded=rootExit>=0 && timer\.ElapsedMilliseconds-rootExit>15000/u)
  assert.match(owner, /while \(cleanup\.ElapsedMilliseconds<10000\)/u)
  assert.match(owner, /completed-with-verified-tool-cleanup/u)
  assert.match(owner, /observedTotal==baselineTotal/u)
  assert.match(owner, /CleanupInventory\(job,candidate\.pid,baselineTotal,out empty,out total\)/u)
  assert.match(owner, /if \(!known\) \{ evidence\.inventoryVerificationFailed=true; return false;/u)
  assert.match(owner, /result\.naturalQuiescence=true/u)
  assert.match(native, /node-with-vendor-policy/u); assert.match(native, /wrong-tool-hash/u)
  assert.match(native, /\$null -ne \$record\.toolCleanup -or \$record\.naturalQuiescence/u)
})
