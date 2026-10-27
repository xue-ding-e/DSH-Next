import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertAllowed, assertFixedPoint, assertIdentity, assertFinalStatus, PRODUCT, BASE, PARENT } from './queue-generation.mjs'
import { isCurrentValidationRun, assertMagpiePredecessor } from './heavy-queue.mjs'
const allowed = new Set(JSON.parse(readFileSync(new URL('./queue-generated-paths.json', import.meta.url))))
test('accepts exact source and reviewed parent, rejects dirty or wrong source', () => {
  assertIdentity(PRODUCT, PARENT, '')
  assert.throws(() => assertIdentity(BASE, BASE, ''))
  assert.throws(() => assertIdentity(PRODUCT, BASE, ''))
  assert.throws(() => assertIdentity(PRODUCT, PARENT, ' M pnpm-lock.yaml'))
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

import { assertReviewedToolChanges, assertRecallClassification, assertRecordFiles, LINK_ADDITIONS, ROOT, BEFORE, AFTER, RECORD_FILES } from './recall-ack-guard.mjs'
test('only exact four ownership links may change in generator scripts, never Typert or persistence tooling', () => {
  const before = 'original\n'
  const after = before + LINK_ADDITIONS.join('\n') + '\n'
  assertReviewedToolChanges(['scripts/gen-cordis-catalog.ts'], before, after)
  assert.throws(() => assertReviewedToolChanges(['scripts/persistence-schema.ts'], before, after))
  assert.throws(() => assertReviewedToolChanges(['scripts/gen-cordis-catalog.ts', 'packages/typert/generator/src/index.ts'], before, after))
  assert.throws(() => assertReviewedToolChanges(['scripts/gen-cordis-catalog.ts'], before, after + 'extra\n'))
})
test('only independently reviewed optional recall transition can be acknowledged', () => {
  const change = { path: `${ROOT}.data.recall`, kind: 'optional-property-added', description: 'optional property added', requiresCompatibilityReview: false }
  const review = { schemaVersion: 1, roots: [{ root: ROOT, before: BEFORE, after: AFTER, changes: [change] }] }
  const check = { ok: false, code: 'unacknowledged-changes', changes: [{ root: ROOT, ...change }], roots: [{ root: ROOT, kind: 'event', before: BEFORE, after: AFTER }], files: [] }
  assertRecallClassification(review, check)
  assert.throws(() => assertRecallClassification({ ...review, roots: [...review.roots, ...review.roots] }, check))
  assert.throws(() => assertRecallClassification({ ...review, roots: [{ ...review.roots[0], after: 'different' }] }, check))
  assert.throws(() => assertRecallClassification({ ...review, roots: [{ ...review.roots[0], changes: [{ ...change, requiresCompatibilityReview: true }] }] }, check))
  assert.throws(() => assertRecallClassification(review, { ...check, code: 'unexpected' }))
})
test('untracked export accepts exactly four official record files, not extra or partial output', () => {
  assertRecordFiles(RECORD_FILES)
  assert.throws(() => assertRecordFiles([...RECORD_FILES, 'other.json']))
  assert.throws(() => assertRecordFiles(RECORD_FILES.slice(1)))
})
