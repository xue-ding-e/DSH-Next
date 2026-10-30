import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { assertDiagnosticOutcome, instrumentMenuTest, runInstrumentedRound, sampleInstrumentation } from './menu-diagnostic.mjs'
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

test('only ordinary pass and assertion failure permit the next diagnostic round', () => {
  for (const status of [0, 1]) assert.doesNotThrow(() => assertDiagnosticOutcome({ status, signal: null }))
  for (const error of [new Error('timeout'), new Error('SIGINT'), new Error('SIGTERM')]) {
    assert.throws(() => assertDiagnosticOutcome({ status: 1, signal: null, error }), /owner failed/)
  }
  for (const status of [null, undefined, 2, 130, 143]) {
    assert.throws(() => assertDiagnosticOutcome({ status, signal: null }))
  }
  assert.throws(() => assertDiagnosticOutcome({ status: 1, signal: 'SIGTERM' }))
})
