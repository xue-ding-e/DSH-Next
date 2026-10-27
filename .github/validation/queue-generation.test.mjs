import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertAllowed, assertFixedPoint, assertIdentity, assertFinalStatus, PRODUCT, BASE } from './queue-generation.mjs'
import { isCurrentValidationRun, assertMagpiePredecessor } from './heavy-queue.mjs'
const allowed = new Set(JSON.parse(readFileSync(new URL('./queue-generated-paths.json', import.meta.url))))
test('accepts exact source and balance parent, rejects dirty or wrong source', () => {
  assertIdentity(PRODUCT, BASE, '')
  assert.throws(() => assertIdentity(BASE, BASE, ''))
  assert.throws(() => assertIdentity(PRODUCT, PRODUCT, ''))
  assert.throws(() => assertIdentity(PRODUCT, BASE, ' M pnpm-lock.yaml'))
})
test('generated paths are exact and cannot authorize source, lock, workflow or arbitrary files', () => {
  assertAllowed(['docs/persistence-schema.json', 'packages/extensions/tool-cordis/src/api-catalog.ts'], allowed)
  for (const path of ['pnpm-lock.yaml', 'packages/core/agent/src/types.ts', '.github/workflows/release.yml', '../secret', 'docs/subsystems/not-a-real-page.md']) assert.throws(() => assertAllowed([path], allowed))
})
test('fixed point compares bytes and file set, not only generator exit code', () => {
  const first = [{ path: 'docs/persistence-schema.json', sha256: 'one' }]
  assertFixedPoint(first, structuredClone(first))
  assert.throws(() => assertFixedPoint(first, [{ ...first[0], sha256: 'two' }]))
  assert.throws(() => assertFixedPoint(first, []))
})
test('queue bypass applies only to exact current control run, never product SHA or former branch', () => {
  const run = { event: 'workflow_dispatch', path: '.github/workflows/next-context-menu-validation.yml', head_branch: 'validation/queue-recall-generation-20261027', id: 1, head_sha: 'control' }
  assert(isCurrentValidationRun('xue-ding-e/DSH-Next', run, '1', 'control'))
  assert(!isCurrentValidationRun('xue-ding-e/DSH-Next', run, '1', PRODUCT))
  assert(!isCurrentValidationRun('xue-ding-e/DSH-Next', { ...run, head_branch: 'validation/workspace-open-folder' }, '1', 'control'))
})
test('Magpie nonterminal predecessor blocks; completed failure releases resources without pretending success', () => {
  const run = { repository: { full_name: 'xue-ding-e/Magpie-Next' }, head_sha: BASE, head_branch: 'security/compress1187-gzip-contract', path: '.github/workflows/test.yml', workflow_id: 393373719, event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' }
  assertMagpiePredecessor(run, BASE)
  assert.throws(() => assertMagpiePredecessor({ ...run, status: 'in_progress', conclusion: null }, BASE))
})

test('nonzero generator status cannot be masked by successful classification', () => {
  for (let index = 0; index < 3; index++) {
    const generated = [true, true, true]
    generated[index] = false
    assert.throws(() => assertFinalStatus(generated, true, true))
  }
})
test('missing acknowledgement or failed review remains failure after successful generation', () => {
  assert.throws(() => assertFinalStatus([true, true, true], true, false))
  assert.throws(() => assertFinalStatus([true, true, true], false, true))
  assertFinalStatus([true, true, true], true, true)
})
