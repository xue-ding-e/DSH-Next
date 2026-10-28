import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verify } from './stage2.mjs'

export const PRODUCT = '35f5fad4bd311fd64846979895f6e26ed3c0a1ae'
export const PARENT = '282f8d630784eab0d935ca06155d96f773983b1e'
export const TREE = 'aff83ad9aee375e56a54c4cdd9b97b03d620dc55'
export const ALLOWED = ['docs/persistence-changes/historical-formats/README.md', 'docs/persistence-changes/historical-formats/README.zh.md', 'docs/persistence-changes/historical-formats/README.i18n.yaml'].sort()
export const ACK = Object.fromEntries([
  ['.i18n.yaml', '33b4063330fc6534cb61598e306f986c1eba50ad8c53591d1d3129f32ce403b2'],
  ['.md', '3e76d42cc32974f7cb381479a3438317d2d6c936871bec6b875fc0e2fb395330'],
  ['.schema.json', '2d5da3d56f2af1d6e9c5939c3dc132cc30e56e62dfb7222132467d883045c6b5'],
  ['.zh.md', '81113e0a7dfed7d509cf3cb28fa8afbc52aa4fe0e430b5fa61e7d606c4c0a308'],
].map(([suffix, hash]) => ['docs/persistence-changes/2026-10-27-queued-message-recall' + suffix, hash]))
export const COMMANDS = [
  ['first-write', ['run', 'verify-persistence-formats', '--write']],
  ['second-write', ['run', 'verify-persistence-formats', '--write']],
  ['readonly-formats', ['run', 'verify-persistence-formats']],
  ['readonly-pair', ['run', 'verify-translation-pairing', 'docs/persistence-changes/historical-formats/README.md']],
  ['readonly-ack', ['run', 'verify-persistence-changes']],
]
export const hash = value => createHash('sha256').update(value).digest('hex')
export function assertScope(paths, untracked) {
  assert.equal(untracked, '', 'new files forbidden')
  assert.deepEqual([...paths].sort(), ALLOWED, 'only the three reviewed README facts may change')
}
export function assertFactShapes(before, after) {
  assert.deepEqual(Object.keys(after).sort(), ALLOWED)
  for (const path of ALLOWED) {
    assert.equal(before[path]?.kind, 'file'); assert.equal(before[path]?.mode, 0o644)
    assert.equal(after[path]?.kind, 'file'); assert.equal(after[path]?.mode, before[path].mode)
  }
}
export function assertSealed(before, after) { assert.deepEqual(after, before, 'source/schema/ack seal changed') }
export function assertFixedPoint(first, second) { assert.deepEqual(second, first, 'generation not a fixed point') }
export function assertExit(result) {
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0)
}
function main() {
  const root = resolve(process.argv[2])
  const evidence = join(process.env.RUNNER_TEMP, 'dsh-next-evidence')
  mkdirSync(evidence, { recursive: true })
  const results = []
  let failure, initial, final, schemaBefore, schemaAfter, generatedFiles, factsBefore, generationSucceeded = false
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 })
    assertExit(r); return r.stdout.trimEnd()
  }
  const files = () => git('ls-files', '-z').split('\0').filter(Boolean)
  const snapshot = paths => Object.fromEntries(paths.map(path => {
    const stat = lstatSync(join(root, path))
    assert(stat.isFile() || stat.isSymbolicLink(), 'unexpected tracked file kind: ' + path)
    return [path, { sha256: hash(stat.isSymbolicLink() ? readlinkSync(join(root, path)) : readFileSync(join(root, path))), mode: stat.mode & 0o777, kind: stat.isSymbolicLink() ? 'symlink' : 'file' }]
  }))
  const schemaFiles = () => files().filter(path => /schema/i.test(path))
  const immutable = () => snapshot(files().filter(path => !ALLOWED.includes(path)))
  const ack = () => Object.fromEntries(Object.keys(ACK).map(path => [path, hash(readFileSync(join(root, path)))]))
  const identity = () => {
    assert.equal(git('rev-parse', 'HEAD'), PRODUCT)
    assert.equal(git('rev-parse', 'HEAD^'), PARENT)
    assert.equal(git('rev-parse', 'HEAD^{tree}'), TREE)
    assert.equal(git('diff', '--cached', '--name-only'), '', 'index changed')
  }
  const guard = () => {
    identity()
    assertSealed(initial, immutable())
    assert.deepEqual(ack(), ACK)
    assertSealed(schemaBefore, snapshot(schemaFiles()))
    assertScope(git('diff', '--name-only', '--no-renames', 'HEAD').split('\n').filter(Boolean), git('ls-files', '--others', '--exclude-standard'))
    assert.equal(git('ls-files', '--others', '--', 'docs'), '', 'any new documentation file, even ignored, is forbidden')
    assert.equal(git('diff', '--name-only', '--diff-filter=ADTR', 'HEAD'), '', 'facts must remain existing regular files')
    assertFactShapes(factsBefore, snapshot(ALLOWED))
  }
  try {
    assert.equal(process.version, 'v24.19.0')
    assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)
    assert.equal(process.env.EXPECTED_PRODUCT_SHA, PRODUCT)
    verify(root, JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url))))
    identity()
    assert.equal(git('status', '--porcelain'), '')
    assert.deepEqual(ack(), ACK)
    assert.equal(git('ls-files', '--others', '--', 'docs'), '')
    initial = immutable(); schemaBefore = snapshot(schemaFiles())
    factsBefore = snapshot(ALLOWED); assertFactShapes(factsBefore, factsBefore)
    const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30000 })
    assertExit(version); assert.equal(version.stdout.trim(), '11.28.5')
    let first
    for (const [label, args] of COMMANDS) {
      const out = openSync(join(evidence, label + '.stdout'), 'w')
      const err = openSync(join(evidence, label + '.stderr'), 'w')
      let r
      try { r = spawnSync('pnpm', args, { cwd: root, stdio: ['ignore', out, err], timeout: 10 * 60 * 1000 }) }
      finally { closeSync(out); closeSync(err) }
      results.push({ label, args, status: r.status, signal: r.signal, error: r.error?.message })
      assertExit(r)
      guard()
      const current = snapshot(ALLOWED)
      if (first) assertFixedPoint(first, current)
      else first = current
    }
    final = immutable(); schemaAfter = snapshot(schemaFiles())
    generatedFiles = snapshot(ALLOWED)
    const patch = git('diff', '--binary', '--no-ext-diff', 'HEAD', '--', ...ALLOWED) + '\n'
    assert(Buffer.byteLength(patch) < 1024 * 1024, 'unexpectedly large generated patch')
    // Export only after every command, exact-path guard and fixed-point check succeeded.
    writeFileSync(join(evidence, 'generated.patch'), patch)
    writeFileSync(join(evidence, 'generated-files.json'), JSON.stringify(generatedFiles, null, 2) + '\n')
    generationSucceeded = true
  } catch (error) {
    failure = error.message; process.exitCode = 1
    if (initial) {
      try {
        final = immutable(); schemaAfter = snapshot(schemaFiles())
        assertSealed(initial, final); assertSealed(schemaBefore, schemaAfter); assert.deepEqual(ack(), ACK)
      } catch (sealError) { failure += '\nFinal seal: ' + sealError.message }
    }
  }
  finally {
    writeFileSync(join(evidence, 'facts-generation-result.json'), JSON.stringify({
      product: PRODUCT, parent: PARENT, tree: TREE, control: process.env.GITHUB_SHA,
      results, failure, generationSucceeded, productValidated: false, complete: false,
      immutableBefore: initial && hash(JSON.stringify(initial)), immutableAfter: final && hash(JSON.stringify(final)),
      schemaBefore, schemaAfter, acceptedRecordHashes: ACK, generatedFiles,
      scope: 'generation-only review evidence; no application validation, merge, release or deployment',
    }, null, 2) + '\n')
  }
}
if (import.meta.main) main()
