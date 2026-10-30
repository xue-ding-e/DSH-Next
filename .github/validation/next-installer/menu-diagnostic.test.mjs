import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { assertionLines, assertDiagnosticOutcome, instrumentMenuTest, runInstrumentedRound, sampleInstrumentation } from './menu-diagnostic.mjs'
import { manifest } from './qualification.mjs'

const fixture = `import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { newEnglishPage, saveFailureShot } from './support.ts'
describe('synthetic menu', () => {
  let workspaceId: string
  beforeAll(async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })
  it.each(['workspace', 'session'])('menu %s', async (kind) => {
    onTestFailed(() => saveFailureShot(page, \`web-e2e-row-context-menu-\${kind}\`))
    await page.setViewportSize({ width: 1200, height: 720 })
    const reopen = page.getByRole('button', { name: 'Open sidebar', exact: true }).first()
    if (await reopen.isVisible()) await reopen.click()
    await menu.waitFor()
    expect(await menu.count()).toBe(1)
    await expect.poll(async () => (await menu.evaluate(element => element.getBoundingClientRect())).width < 420).toBe(true)
  })
})
`

test('both overlays parse as TypeScript and retain every menu assertion and default timeout', () => {
  for (const synchronize of [false, true]) {
    const overlay = instrumentMenuTest(fixture, synchronize)
    assert.doesNotThrow(() => stripTypeScriptTypes(overlay))
    for (const line of fixture.split('\n').filter(line => line.includes('expect(') || line.includes('expect.poll') || line.includes('menu.waitFor'))) {
      assert(overlay.includes(line), line)
    }
    assert(!overlay.includes('timeout:'))
    assert(!overlay.includes('setTimeout'))
    assert(!overlay.includes('waitForTimeout'))
  }
})

test('original observation preserves the immediate check and control waits for actual sidebar state', () => {
  const original = instrumentMenuTest(fixture, false)
  const control = instrumentMenuTest(fixture, true)
  assert(original.includes('if (await reopen.isVisible()) await reopen.click()'))
  assert(!control.includes('reopen.isVisible()'))
  assert(control.includes("await reopen.waitFor({ state: 'visible' })\n    await reopen.click()"))
  assert.equal(control.match(/name: 'Collapse sidebar'/gu).length, 2)
})

test('missing or duplicate reviewed patch site refuses instead of altering arbitrary fixtures', () => {
  assert.throws(() => instrumentMenuTest(fixture.replace('let workspaceId: string', 'let other: string'), false))
  assert.throws(() => instrumentMenuTest(fixture + '\n  let workspaceId: string', true))
})

test('sampling is bounded metadata only and runs after passing as well as failing cases', () => {
  const overlay = instrumentMenuTest(fixture, false)
  assert(overlay.includes('afterEach(async () =>'))
  assert(overlay.includes('samplingError'))
  assert(sampleInstrumentation.includes('< 300'))
  for (const forbidden of ['innerHTML', 'textContent', 'document.cookie', 'localStorage', 'location.href', 'fetch(', 'request.']) {
    assert(!sampleInstrumentation.includes(forbidden), forbidden)
  }
  assert(overlay.includes('Diagnostic transport failure must not mask a product assertion'))
  assert(overlay.includes('A detached page must not obscure the original failed assertion'))
})

for (const status of [0, 1]) {
  test(`quiescent round with exit ${status} restores exact bytes without qualifying diagnostic outcome`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-menu-round-'))
    const file = join(dir, 'fixture.ts'), original = Buffer.from('original\r\n')
    try {
      writeFileSync(file, original)
      const expected = { status, ownership: { cleanupConfirmed: true, record: { survivors: {} } } }
      const result = await runInstrumentedRound(file, original, 'overlay', async () => {
        assert.equal(readFileSync(file, 'utf8'), 'overlay')
        return expected
      })
      assert.equal(result, expected)
      assert(readFileSync(file).equals(original))
    } finally { rmSync(file, { force: true }); rmdirSync(dir) }
  })
}

for (const ownership of [undefined, { cleanupConfirmed: false, record: { survivors: {} } }, { cleanupConfirmed: true, record: { survivors: { 42: true } } }, { cleanupConfirmed: true, record: {} }]) {
  test('unconfirmed process ownership retains overlay for investigation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-menu-owned-')), file = join(dir, 'fixture.ts')
    try {
      writeFileSync(file, 'original')
      await assert.rejects(runInstrumentedRound(file, Buffer.from('original'), 'overlay', async () => ({ ownership })), /ownership is unconfirmed/u)
      assert.equal(readFileSync(file, 'utf8'), 'overlay')
    } finally { rmSync(file, { force: true }); rmdirSync(dir) }
  })
}

test('command rejection is not hidden by restoring a potentially live fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-menu-reject-')), file = join(dir, 'fixture.ts')
  const failure = new Error('synthetic command failed before ownership receipt')
  try {
    writeFileSync(file, 'original')
    await assert.rejects(runInstrumentedRound(file, Buffer.from('original'), 'overlay', async () => { throw failure }), error => error === failure)
    assert.equal(readFileSync(file, 'utf8'), 'overlay')
  } finally { rmSync(file, { force: true }); rmdirSync(dir) }
})

test('workflow keeps fixed source, manual-only read-only diagnostic scope and unconditional evidence', () => {
  const workflow = readFileSync(new URL('../../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
  const source = readFileSync(new URL('./menu-diagnostic.mjs', import.meta.url), 'utf8')
  assert.equal(manifest.controlRef, 'refs/heads/validation/next-menu-diagnostic-20261030')
  assert.equal(manifest.source, '097405ae7f990d34a17a2afe689db17df55932a3')
  assert(workflow.includes('contents: read'))
  assert(workflow.includes('workflow_dispatch:'))
  assert(!/\n  (push|pull_request|schedule):/u.test(workflow))
  assert(workflow.includes('menu-diagnostic.test.mjs'))
  assert(workflow.includes('if: always()'))
  assert(workflow.includes('qualified') === false)
  assert(source.includes('qualified: false'))
  assert(!/gh release|npm publish|contents: write/u.test(workflow))
})

const ordinaryResult = status => ({ status, signal: null, cancelled: false,
  error: status === 1 ? new Error('RuntimeError: command: nonzero_exit; see command evidence') : undefined,
  ownership: { cleanupConfirmed: true, record: { exit_code: status, reason: status === 1 ? 'nonzero_exit' : 'completed', survivors: {} } } })
const failedReport = () => ({ success: false, numTotalTests: 2, numPendingTests: 0, numPassedTests: 1, numFailedTests: 1,
  testResults: [{ name: '/product/apps/web/tests/row-context-menu.e2e.ts',
    assertionResults: [{ fullName: 'web e2e: row context-menu placement keeps the workspace menu at its requested anchor with dismissal and focus return', status: 'failed', failureMessages: ['TimeoutError: locator.waitFor\n    at /product/apps/web/tests/row-context-menu.e2e.ts:100:5'] },
      { fullName: 'web e2e: row context-menu placement keeps the session menu at its requested anchor with dismissal and focus return', status: 'passed', failureMessages: [] }] }] })

test('real owner nonzero_exit plus an actual failed assertion permits diagnostic comparison', () => {
  assert.doesNotThrow(() => assertDiagnosticOutcome(ordinaryResult(0)))
  assert.doesNotThrow(() => assertDiagnosticOutcome(ordinaryResult(1), failedReport(), [100]))
})

test('startup, malformed or missing reports never qualify exit one as an assertion failure', () => {
  for (const report of [undefined, {}, { ...failedReport(), numTotalTests: 0 },
    { ...failedReport(), numRuntimeErrors: 1 }, { ...failedReport(), numFailedTests: 0 },
    { ...failedReport(), testResults: [] }, { ...failedReport(), success: true }]) {
    assert.throws(() => assertDiagnosticOutcome(ordinaryResult(1), report, [100]))
  }
  const report = failedReport()
  report.testResults[0].assertionResults[0].failureMessages = []
  assert.throws(() => assertDiagnosticOutcome(ordinaryResult(1), report, [100]))
})

test('cancellation, timeout and unknown ownership stop even when a failure report exists', () => {
  for (const reason of ['timeout', 'cancelled', 'surviving_descendants_after_parent_exit']) {
    const result = ordinaryResult(1); result.ownership.record.reason = reason
    assert.throws(() => assertDiagnosticOutcome(result, failedReport(), [100]))
  }
  for (const patch of [{ cancelled: true }, { cancelled: undefined }, { signal: 'SIGTERM' }, { status: 2 }]) {
    assert.throws(() => assertDiagnosticOutcome({ ...ordinaryResult(1), ...patch }, failedReport(), [100]))
  }
  const result = ordinaryResult(1); result.ownership.record.survivors = { 123: 'live' }
  assert.throws(() => assertDiagnosticOutcome(result, failedReport(), [100]))
})

test('assertion callsite proof rejects hook startup, missing stacks and duplicate cases', () => {
  assert.deepEqual(assertionLines('setup()\nawait menu.waitFor()\nexpect(true).toBe(true)\nawait expect.poll(check).toBe(true)'), [2, 3, 4])
  for (const message of ['beforeAll failed', 'Error\n    at /product/apps/web/tests/row-context-menu.e2e.ts:30:5', 'Error mentions /product/apps/web/tests/row-context-menu.e2e.ts:100:5', 'Error\n    at /product/other/row-context-menu.e2e.ts:100:5']) {
    const report = failedReport(); report.testResults[0].assertionResults[0].failureMessages = [message]
    assert.throws(() => assertDiagnosticOutcome(ordinaryResult(1), report, [100]))
  }
  const report = failedReport()
  report.testResults[0].assertionResults[1].fullName = report.testResults[0].assertionResults[0].fullName
  assert.throws(() => assertDiagnosticOutcome(ordinaryResult(1), report, [100]))
})

test('recognized ANSI and named stack frames retain precise assertion callsite proof', () => {
  for (const frame of ['    at run (/product/apps/web/tests/row-context-menu.e2e.ts:100:5)',
    ' ❯ /product/apps/web/tests/row-context-menu.e2e.ts:100:5',
    '\u001b[31m    at /product/apps/web/tests/row-context-menu.e2e.ts:100:5\u001b[0m']) {
    const report = failedReport(); report.testResults[0].assertionResults[0].failureMessages = ['Error\n' + frame]
    assert.doesNotThrow(() => assertDiagnosticOutcome(ordinaryResult(1), report, [100]))
  }
})
