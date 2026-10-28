import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ALLOWED, REQUIRED, WRITES, ACK, COMMANDS, PRODUCT, PARENT, TREE, assertScope, assertFactShapes, assertSealed, assertFixedPoint, assertExit, patchOutput } from './documentation-generation.mjs'
const workflow = readFileSync(new URL('../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
const source = readFileSync(new URL('./documentation-generation.mjs', import.meta.url), 'utf8')
test('only four exact outputs allowed, three required after first group, optional sidecar', () => {
  assertScope([], '')
  assertScope(REQUIRED, '', true)
  assertScope(ALLOWED, '', true)
  assert.throws(() => assertScope(REQUIRED.slice(1), '', true))
  for (const paths of [[...ALLOWED, 'docs/persistence-schema.json'], [...ALLOWED, ...ALLOWED]]) assert.throws(() => assertScope(paths, ''))
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
test('exact product two-commit chain tree and accepted hashes pinned', () => {
  const m = JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url)))
  assert.equal(PRODUCT, m.final); assert.equal(TREE, m.tree)
  assert.equal(PARENT, m.chain[1].parent); assert.equal(m.chain.length, 2)
  assert.equal(m.files.length, 124); assert.equal(m.tests.length, 35)
  assert.equal(Object.keys(ACK).length, 4)
  for (const [path, sha] of Object.entries(ACK)) { assert(path.startsWith('docs/persistence-changes/2026-10-27-queued-message-recall.')); assert.match(sha, /^[a-f0-9]{64}$/) }
})
test('two exact official groups then readonly checks; no broad or acknowledgement writes', () => {
  assert.deepEqual(WRITES, [['run', 'gen-doc-graphs'], ['run', 'gen-client-catalog'], ['run', 'verify-translation-pairing', '--write', 'docs/event-producer-consumer.md']])
  assert.deepEqual(COMMANDS.slice(0, 3).map(x => x[1]), WRITES)
  assert.deepEqual(COMMANDS.slice(3, 6).map(x => x[1]), WRITES)
  assert.deepEqual(COMMANDS.slice(6).map(x => x[0]), ['readonly-graphs', 'readonly-client', 'readonly-pair', 'readonly-ack', 'readonly-formats'])
  assert(COMMANDS.slice(6).every(x => !x[1].includes('--write')))
  assert(source.includes("label === 'first-2'")); assert(source.includes("label === 'second-2' || label.startsWith('readonly-')"))
  assert(source.includes('assertExit(r)\n      guard()'))
  assert(source.includes('productValidated: false')); assert(source.includes('complete: false'))
})
test('workflow clearly generation-only, independent of formal application validation', () => {
  assert(workflow.startsWith('name: Next bounded documentation generation-only'))
  assert(workflow.includes('run: pnpm install --frozen-lockfile --ignore-scripts\n'))
  assert(workflow.includes('run: node control/.github/validation/documentation-generation.mjs product\n'))
  assert(workflow.includes('stage2.mjs product --identity-only'))
  assert(!workflow.includes('run: node control/.github/validation/stage2.mjs product\n'))
  assert(workflow.includes('run: node --test control/.github/validation/stage2.test.mjs control/.github/validation/documentation-generation.test.mjs'))
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
  assert(workflow.includes('fetch-depth: 3'))
  assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, 2)
  assert(workflow.includes('test -z "$(git -C product status --porcelain)"'))
  assert(workflow.includes('test ! -e product/.env'))
  assert(workflow.includes('include-hidden-files: false'))
  assert(source.includes("assert(Buffer.byteLength(patch) < 1024 * 1024"))
})

test('Generated outputs reject deletion, symlink and executable-mode changes', () => {
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

test('runtime raw export is checked by isolated-index application and exact output hashes', () => {
  assert(source.includes("indexGit(['apply', '--cached', '--check', '-'], patch)"))
  assert(source.includes("indexGit(['apply', '--cached', '-'], patch)"))
  assert(source.includes("hash(Buffer.from(staged.stdout)), generatedFiles[path].sha256"))
  assert(source.includes("if (existsSync(index)) unlinkSync(index)"))
  assert(source.indexOf("'patch roundtrip mismatch: '") < source.indexOf("writeFileSync(join(evidence, 'generated.patch')"))
})
