import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ALLOWED, ACK, COMMANDS, PRODUCT, PARENT, TREE, assertScope, assertFactShapes, assertSealed, assertFixedPoint, assertExit, patchOutput } from './facts-generation.mjs'
const workflow = readFileSync(new URL('../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
const source = readFileSync(new URL('./facts-generation.mjs', import.meta.url), 'utf8')
test('only exact three README files and no new files allowed', () => {
  assertScope(ALLOWED, '')
  for (const paths of [ALLOWED.slice(1), [...ALLOWED, 'docs/persistence-schema.json'], [...ALLOWED, ...ALLOWED]]) assert.throws(() => assertScope(paths, ''))
  assert.throws(() => assertScope(ALLOWED, 'new-file'))
})
test('source and schema seals reject byte, mode, kind, missing and added changes', () => {
  const seal = { path: { sha256: 'a', mode: 420, kind: 'file' } }
  assertSealed(seal, structuredClone(seal))
  for (const next of [{}, { ...seal, other: 'b' }, { path: { ...seal.path, sha256: 'b' } }, { path: { ...seal.path, mode: 493 } }, { path: { ...seal.path, kind: 'symlink' } }]) assert.throws(() => assertSealed(seal, next))
})
test('fixed point rejects second write or readonly mutation', () => {
  assertFixedPoint({ x: 'a' }, { x: 'a' })
  assert.throws(() => assertFixedPoint({ x: 'a' }, { x: 'b' }))
})
test('command errors, signals and nonzero statuses fail closed', () => {
  assertExit({ status: 0, signal: null })
  for (const r of [{ status: 1, signal: null }, { status: 0, signal: 'SIGTERM' }, { status: null, signal: null, error: new Error('timeout') }]) assert.throws(() => assertExit(r))
})
test('exact reviewed product parent tree and accepted hashes remain pinned', () => {
  const m = JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url)))
  // Historical generation source stays pinned; the formal manifest now includes its reviewed output.
  assert.equal(PRODUCT, '35f5fad4bd311fd64846979895f6e26ed3c0a1ae'); assert.equal(TREE, 'aff83ad9aee375e56a54c4cdd9b97b03d620dc55'); assert.equal(PARENT, m.base)
  assert.equal(m.files.length, 80); assert.equal(m.tests.length, 35)
  assert.equal(Object.keys(ACK).length, 4)
  for (const [path, sha] of Object.entries(ACK)) { assert(path.startsWith('docs/persistence-changes/2026-10-27-queued-message-recall.')); assert.match(sha, /^[a-f0-9]{64}$/) }
})
test('two official writes followed only by required readonly checks', () => {
  assert.deepEqual(COMMANDS.map(x => x[0]), ['first-write', 'second-write', 'readonly-formats', 'readonly-pair', 'readonly-ack'])
  assert.deepEqual(COMMANDS[0][1], ['run', 'verify-persistence-formats', '--write'])
  assert.deepEqual(COMMANDS[1][1], COMMANDS[0][1])
  assert(COMMANDS.slice(2).every(x => !x[1].includes('--write')))
  assert(source.indexOf('assertExit(r)\n      guard()') < source.indexOf("writeFileSync(join(evidence, 'generated.patch')"))
  assert(source.includes('productValidated: false')); assert(source.includes('complete: false'))
})
test('formal workflow restored without generator writes or skipped validation', () => {
  assert(workflow.startsWith('name: Next queue recall locked-toolchain validation'))
  assert(workflow.includes('run: pnpm install --frozen-lockfile\n'))
  assert(workflow.includes('run: node control/.github/validation/stage2.mjs product\n'))
  assert(workflow.includes('stage2.mjs product --identity-only'))
  assert(!workflow.includes('facts-generation.mjs product'))
  assert(!workflow.includes('--write'))
  assert(workflow.includes('run: node --test control/.github/validation/stage2.test.mjs'))
})
test('four exact actions and read-only serial queue guard remain', () => {
  assert.deepEqual([...new Set([...workflow.matchAll(/uses: ([^\n]+)/g)].map(x => x[1]))].sort(), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  ].sort())
  assert.match(workflow, /permissions:\n  contents: read\nconcurrency:\n  group: next-reviewed-heavy-validation\n  cancel-in-progress: false/)
  assert(workflow.includes('node control/.github/validation/heavy-queue.mjs'))
  assert(workflow.includes('timeout-minutes: 270'))
})
test('bounded source checkout and credential isolation retained', () => {
  assert(workflow.includes('fetch-depth: 2'))
  assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, 2)
  assert(workflow.includes('test -z "$(git -C product status --porcelain)"'))
  assert(workflow.includes('test ! -e product/.env'))
  assert(workflow.includes('include-hidden-files: false'))
  assert(source.includes("assert(Buffer.byteLength(patch) < 1024 * 1024"))
})

test('README facts reject deletion, symlink and executable-mode changes', () => {
  const before = Object.fromEntries(ALLOWED.map(path => [path, { kind: 'file', mode: 0o644 }]))
  assertFactShapes(before, structuredClone(before))
  for (const change of [next => delete next[ALLOWED[0]], next => next[ALLOWED[0]].kind = 'symlink', next => next[ALLOWED[0]].mode = 0o755]) {
    const next = structuredClone(before); change(next); assert.throws(() => assertFactShapes(before, next))
  }
  assert(source.includes("git('ls-files', '--others', '--', 'docs')"))
  assert(source.includes("'--diff-filter=ADTR'"))
})

test('patch serialization preserves trailing blank context and round-trips through git', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-patch-framing-'))
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  try {
    assertExit(git('init', '-q'))
    writeFileSync(join(cwd, 'facts.md'), 'before\n\n')
    assertExit(git('add', 'facts.md'))
    writeFileSync(join(cwd, 'facts.md'), 'after\n\n')
    const raw = git('diff', '--', 'facts.md')
    const patch = patchOutput(raw)
    assert(patch.endsWith(' \n'))
    assertExit(spawnSync('git', ['apply', '--check', '--reverse', '-'], { cwd, encoding: 'utf8', input: patch }))
    assert.notEqual(spawnSync('git', ['apply', '--check', '--reverse', '-'], { cwd, encoding: 'utf8', input: patch.trimEnd() + '\n' }).status, 0)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
