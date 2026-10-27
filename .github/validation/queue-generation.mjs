import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const PRODUCT = '37a01405d485a8a5d509a60e36819d2b0e749285'
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
  assert.equal(parent, BASE)
  assert.equal(status, '', 'product checkout must start clean')
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
    observed.control = process.env.GITHUB_SHA
    observed.expectedControl = process.env.EXPECTED_CONTROL_SHA
    const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30_000 })
    observed.pnpm = { status: version.status, version: version.stdout?.trim(), error: version.error?.message }
    assert.equal(version.status, 0, 'cannot verify actual pnpm version')
    assert.equal(observed.pnpm.version, '11.28.5')
    assertIdentity(observed.head, observed.parent, git('status', '--porcelain'))
    assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA, 'unreviewed control SHA')
    const allowed = new Set(JSON.parse(readFileSync(new URL('./queue-generated-paths.json', import.meta.url), 'utf8')))
    const snapshot = () => {
      const changes = [...new Set([...git('diff', '--name-only', '-z', 'HEAD').split('\0'), ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort()
      assertAllowed(changes, allowed)
      return changes.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) }))
    }
    // Baseline type declarations and generator implementation must be the same
    // tool family; this source candidate changes no generator code.
    assert.equal(git('diff', '--name-only', BASE, PRODUCT, '--', 'scripts'), '')
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
    const acknowledged = run('verify-persistence-changes', ['--silent', 'run', 'verify-persistence-changes', '--json'])
    snapshot()
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
      assert.equal(untracked.length, 0, 'new generator output needs explicit artifact review; no incomplete patch')
      writeFileSync(join(evidence, 'generated.patch'), git('diff', '--binary', 'HEAD'))
      writeFileSync(join(evidence, 'generated-files.json'), JSON.stringify(paths.map(path => ({ path, sha256: sha256(readFileSync(join(root, path))) })), null, 2) + '\n')
    } catch (error) { failure = `${failure ?? ''}\nArtifact guard: ${error.message}`; process.exitCode = 1 }
    writeFileSync(join(evidence, 'generation-result.json'), JSON.stringify({ product: PRODUCT, base: BASE, control: process.env.GITHUB_SHA, node: process.version, packageManager: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager, observed, lockSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))), results, failure, complete: false, scope: 'unvalidated generated diff only; no product acceptance or persistence acknowledgement' }, null, 2) + '\n')
  }
}
if (import.meta.main) main()
