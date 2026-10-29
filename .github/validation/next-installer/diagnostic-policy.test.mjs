import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertDiagnosticMode, assertDiagnosticResult } from './diagnostic-policy.mjs'

test('diagnostic mode cannot be omitted, substituted with qualification, or applied to an unsealed manifest', () => {
  for (const mode of ['install-dependencies', 'diagnose']) assertDiagnosticMode({ diagnosticOnly: true }, mode)
  for (const mode of [undefined, 'qualify', 'package', 'install', '']) assert.throws(() => assertDiagnosticMode({ diagnosticOnly: true }, mode))
  for (const flag of [undefined, false, 'true']) assert.throws(() => assertDiagnosticMode({ diagnosticOnly: flag }, 'diagnose'))
})
test('passing and failing diagnostic records are never qualified and cannot contain package or lifecycle evidence', () => {
  const record = { diagnosticOnly: true, qualified: false, packages: [], stages: [{ label: 'desktop-tests' }] }
  assertDiagnosticResult(record); assertDiagnosticResult({ ...record, stages: [], failure: 'owned descendants survived grace' })
  for (const extra of [{ diagnosticOnly: false }, { qualified: true }, { packages: [{ version: '0.2.1' }] },
    { stages: [{ label: 'package-v1' }] }, { stages: [{ label: 'real-upgrade-v2' }] }, { stages: null }]) {
    assert.throws(() => assertDiagnosticResult({ ...record, ...extra }))
  }
})
test('the diagnostic driver has no package or installer entry and invokes the mode and result gates', () => {
  const driver = readFileSync(new URL('./windows-qualify.ps1', import.meta.url), 'utf8')
  assert.match(driver, /ValidateSet\('install-dependencies','diagnose'\)/u)
  assert.match(driver, /'diagnostic-policy\.mjs'\) mode/u); assert.match(driver, /'diagnostic-policy\.mjs'\) result/u)
  assert.match(driver, /diagnosticOnly=\$true; qualified=\$false/u)
  assert.doesNotMatch(driver, /package:next:win|package-target\.ts|windows-installer\.ps1|Run-Pnpm 'smoke-profile-tests'/u)
  const workflow = readFileSync(new URL('../../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
  assert.match(workflow, /windows-qualify\.ps1 -Product product -Mode diagnose/u)
})
