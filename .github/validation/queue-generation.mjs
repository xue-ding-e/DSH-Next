import { assertReviewedToolChanges, assertAcceptedRecord, ACCEPTED_RECORD_HASHES, DOC_PAIRS } from './recall-ack-guard.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const PRODUCT = '2bdf983f05368d30534e036992d0ac07f3b75891'
export const PARENT = '24bf1efa6e315d91bcb9abac1842ff035135df1d'
export const BASE = '282f8d630784eab0d935ca06155d96f773983b1e'
const generators = ['gen-cordis-catalog', 'gen-cordis-inspect-catalog', 'gen-persistence-catalog']
const sha256 = data => createHash('sha256').update(data).digest('hex')
export function assertAllowed(paths, allowed) {
  for (const path of paths) assert(allowed.has(path), `unexpected generated change: ${path}`)
}
export function assertFixedPoint(first, second) {
  assert.deepEqual(second, first, 'generators did not reach a fixed point')
}
export function assertIdentity(head, parent, status) {
  assert.equal(head, PRODUCT)
  assert.equal(parent, PARENT)
  assert.equal(status, '', 'product checkout must start clean')
}
export function assertBaseAncestor(ancestor) {
  assert.equal(ancestor, BASE, 'fourth ancestor must be the reviewed balance baseline')
}
export function assertFinalStatus(generated, review, acknowledged) {
  assert(generated.every(Boolean) && review && acknowledged, 'generation, persistence review or acknowledgement gate failed; inspect recorded exit statuses')
}
function main() {
  const root = resolve(process.argv[2])
  const evidence = resolve(process.env.RUNNER_TEMP, 'dsh-next-evidence')
  mkdirSync(evidence, { recursive: true })
  const results = []
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
    assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`)
    return r.stdout
  }
  const run = (label, args) => {
    const out = openSync(join(evidence, `${label}.stdout`), 'w')
    const err = openSync(join(evidence, `${label}.stderr`), 'w')
    let r
    try { r = spawnSync('pnpm', args, { cwd: root, stdio: ['ignore', out, err], timeout: 10 * 60_000 }) }
    finally { closeSync(out); closeSync(err) }
    results.push({ label, args, status: r.status, signal: r.signal, error: r.error?.message })
    return r.status === 0 && !r.error
  }
  let failure
  const observed = {}
  try {
    observed.head = git('rev-parse', 'HEAD').trim()
    observed.parent = git('rev-parse', 'HEAD^').trim()
    observed.baseAncestor = git('rev-parse', 'HEAD~4').trim()
    assertBaseAncestor(observed.baseAncestor)
    observed.control = process.env.GITHUB_SHA
    observed.expectedControl = process.env.EXPECTED_CONTROL_SHA
    const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30_000 })
    observed.pnpm = { status: version.status, version: version.stdout?.trim(), error: version.error?.message }
    assert.equal(version.status, 0, 'cannot verify actual pnpm version')
    assert.equal(observed.pnpm.version, '11.28.5')
    assertIdentity(observed.head, observed.parent, git('status', '--porcelain'))
    assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA, 'unreviewed control SHA')
    const acceptedHashes = () => Object.fromEntries(Object.keys(ACCEPTED_RECORD_HASHES).map(path => [path, sha256(readFileSync(join(root, path)))]))
    assert.deepEqual(acceptedHashes(), ACCEPTED_RECORD_HASHES, 'approved record bytes must match before generation')
    const allowed = new Set(JSON.parse(readFileSync(new URL('./queue-generated-paths.json', import.meta.url), 'utf8')))
    const snapshot = () => {
      const changes = [...new Set([...git('diff', '--name-only', '-z', 'HEAD').split('\0'), ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort()
      assertAllowed(changes, allowed)
      return changes.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }))
    }
    const changedTools = git('diff', '--name-only', BASE, PRODUCT, '--', 'scripts', 'packages/typert').trim().split('\n').filter(Boolean)
    assertReviewedToolChanges(changedTools, git('show', `${BASE}:scripts/gen-cordis-catalog.ts`), git('show', `${PRODUCT}:scripts/gen-cordis-catalog.ts`))
    writeFileSync(join(evidence, 'base.schema.json'), git('show', `${BASE}:docs/persistence-schema.json`))
    const generated = generators.map(name => run(`first-${name}`, ['run', name]))
    const first = snapshot()
    if (generated.every(Boolean)) {
      const repeated = generators.map(name => run(`second-${name}`, ['run', name]))
      assert(repeated.every(Boolean), 'second generator pass failed')
      assertFixedPoint(first, snapshot())
      const fresh = generators.map(name => run(`check-${name}`, ['run', name, '--check']))
      assert(fresh.every(Boolean), 'generator freshness failed')
    }
    assert(generated[2], 'persistence generation failed; do not classify stale inventory')
    const before = JSON.parse(readFileSync(join(evidence, 'base.schema.json'), 'utf8'))
    const after = JSON.parse(readFileSync(join(root, 'docs/persistence-schema.json'), 'utf8'))
    assert.equal(before.formatVersion, after.formatVersion, 'baseline normalization differs; regenerate baseline with current tooling before review')
    // No acknowledgement is fabricated here. A required decision or missing
    // acknowledgement remains nonzero and visible, even if the diff is useful.
    const review = run('persistence-review', ['--silent', 'run', 'persistence-review', '--before', join(evidence, 'base.schema.json'), '--after', 'docs/persistence-schema.json', '--json'])
    const initialAck = run('verify-existing-record', ['--silent', 'run', 'verify-persistence-changes', '--json'])
    assert(review && initialAck, 'independent review and existing exact acknowledgement must pass')
    assertAcceptedRecord(JSON.parse(readFileSync(join(evidence, 'persistence-review.stdout'), 'utf8')), JSON.parse(readFileSync(join(evidence, 'verify-existing-record.stdout'), 'utf8')), acceptedHashes())
    assert(generated.every(Boolean), 'all generators must succeed')
    assert.equal(git('ls-files', '--others', '--exclude-standard', '-z'), '', 'no new records or files authorized')
    const recorded = snapshot()
    for (const name of generators) assert(run(`final-${name}`, ['run', name]), 'post-record generator failed')
    assertFixedPoint(recorded, snapshot())
    for (const name of generators) assert(run(`final-check-${name}`, ['run', name, '--check']), 'final freshness failed')
    const acknowledged = run('verify-persistence-changes', ['--silent', 'run', 'verify-persistence-changes', '--json'])
    assert(run('verify-doc-pairs', ['run', 'verify-translation-pairing', ...DOC_PAIRS]), 'paired documentation check failed')
    snapshot()
    assert.deepEqual(acceptedHashes(), ACCEPTED_RECORD_HASHES, 'accepted acknowledgement changed during generation')
    assertFinalStatus(generated, review, acknowledged)
  } catch (error) {
    failure = error.message
    process.exitCode = 1
  } finally {
    // Export only the known generated paths, and refuse a patch if any source,
    // workflow, lockfile or unexpected file was modified, including on failure.
    try {
      const allowed = new Set(JSON.parse(readFileSync(new URL('./queue-generated-paths.json', import.meta.url), 'utf8')))
      const paths = git('diff', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean)
      const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
      assertAllowed([...paths, ...untracked], allowed)
      assert.equal(untracked.length, 0, 'no untracked files or new acknowledgement permitted')
      const index = join(process.env.RUNNER_TEMP, 'dsh-generated-artifact.index')
      const isolatedGit = (...args) => {
        const r = spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
        assert.equal(r.status, 0, 'isolated artifact index failed')
        return r.stdout
      }
      isolatedGit('read-tree', 'HEAD')
      const exported = [...paths, ...untracked]
      if (exported.length) isolatedGit('add', '--', ...exported)
      writeFileSync(join(evidence, 'generated.patch'), isolatedGit('diff', '--cached', '--binary', 'HEAD'))
      writeFileSync(join(evidence, 'generated-files.json'), JSON.stringify([...paths, ...untracked].map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })), null, 2) + '\n')
    } catch (error) { failure = `${failure ?? ''}\nArtifact guard: ${error.message}`; process.exitCode = 1 }
    writeFileSync(join(evidence, 'generation-result.json'), JSON.stringify({ product: PRODUCT, base: BASE, control: process.env.GITHUB_SHA, node: process.version, packageManager: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager, observed, lockSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))), results, failure, complete: false, scope: 'unvalidated generated diff only; official scoped acknowledgement is reviewable, not product acceptance' }, null, 2) + '\n')
  }
}
if (import.meta.main) main()
