import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, lstatSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { verify } from './stage2.mjs'
import { ACK } from './facts-generation.mjs'

// Read-only diagnostics: nonzero freshness checks remain failures, never permission to generate.
export const CHECKS = [
  'verify-doc-graphs', 'verify-client-catalog', 'verify-cordis-catalog',
  'verify-cordis-inspect-catalog', 'verify-persistence-catalog', 'verify-type-equiv',
  'verify-export-jsdoc', 'verify-package-readme-summaries', 'verify-doc-budgets',
  'verify-md-links', 'verify-translation-pairing', 'verify-persistence-changes',
  'verify-persistence-formats',
]
export function classify(result, output) {
  assert.equal(result.error, undefined); assert.equal(result.signal, null)
  if (result.status === 0) return 'passed'
  assert.equal(result.status, 1, 'unexpected check process exit')
  assert(!/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ENOENT|command not found|SyntaxError|TypeError|ReferenceError/i.test(output), 'check infrastructure or runtime error')
  if (/stale(?: graph doc| —| —|\. |\s|:)|Stale persistence format facts/i.test(output)) return 'stale'
  assert(/violation|verification failed|verify-doc-budgets failed|broken relative cross-links|bilingual pairing rules violated/i.test(output), 'unclassified nonzero check; stop diagnostics')
  return 'validation-failed'
}
export async function inspect(rootInput, manifest, evidenceInput) {
  const root = resolve(rootInput), evidence = resolve(evidenceInput)
  assert.match(manifest.final, /^[a-f0-9]{40}$/)
  assert.equal(manifest.chain.length, 2, 'reviewed queue feature and independent initialization fix required')
  verify(root, manifest)
  mkdirSync(evidence, { recursive: true })
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(r.status, 0); return r.stdout
  }
  const paths = git('ls-files', '-z').split('\0').filter(Boolean)
  const snapshot = () => Object.fromEntries(paths.map(path => {
    const stat = lstatSync(join(root, path))
    assert(stat.isFile() || stat.isSymbolicLink())
    return [path, { sha256: hash(stat.isSymbolicLink() ? readlinkSync(join(root, path)) : readFileSync(join(root, path))), mode: stat.mode & 0o777, kind: stat.isSymbolicLink() ? 'symlink' : 'file' }]
  }))
  const before = snapshot()
  const schema = values => Object.fromEntries(Object.entries(values).filter(([path]) => /schema/i.test(path)))
  for (const [path, digest] of Object.entries(ACK)) assert.equal(before[path].sha256, digest)
  const guard = () => {
    verify(root, manifest)
    assert.equal(git('ls-files', '--others', '--exclude-standard').trim(), '')
    assert.equal(git('ls-files', '--others', '--', 'docs').trim(), '')
    assert.deepEqual(snapshot(), before, 'readonly check modified source/schema/ack bytes or file mode')
  }
  guard()
  const results = []
  let failure, after
  try {
  for (const name of CHECKS) {
    const out = openSync(join(evidence, name + '.stdout'), 'w')
    const err = openSync(join(evidence, name + '.stderr'), 'w')
    let result
    try {
      result = spawnSync('pnpm', ['run', name], { cwd: root, stdio: ['ignore', out, err], timeout: 10 * 60 * 1000 })
    } finally { closeSync(out); closeSync(err) }
    const entry = { name, status: result.status, signal: result.signal, error: result.error?.message }
    results.push(entry)
    const output = readFileSync(join(evidence, name + '.stdout'), 'utf8') + readFileSync(join(evidence, name + '.stderr'), 'utf8')
    entry.classification = classify(result, output)
    // A stale-check exit is recorded, never relabelled a pass; I/O/timeouts abort collection.
    assert.equal(result.error, undefined); assert.equal(result.signal, null)
    guard()
  }
  } catch (error) { failure = error.message }
  try { guard(); after = snapshot() } catch (error) { failure = (failure ?? '') + '\nFinal seal: ' + error.message }
  const failed = results.filter(r => r.status !== 0)
  writeFileSync(join(evidence, 'readonly-freshness-result.json'), JSON.stringify({
    source: manifest.final, tree: manifest.tree, chain: manifest.chain,
    results, failure, immutableBefore: hash(JSON.stringify(before)), immutableAfter: after && hash(JSON.stringify(after)), schemaBefore: schema(before), schemaAfter: after && schema(after), acceptedRecordHashes: ACK, productValidated: false, generationPerformed: false, complete: false,
    freshnessPassed: !failure && results.length === CHECKS.length && failed.length === 0,
    scope: 'readonly diagnostic collection; nonzero checks require review before any bounded generation',
  }, null, 2) + '\n')
  return !failure && results.length === CHECKS.length && failed.length === 0 ? 0 : 1
}
if (import.meta.main) {
  assert.equal(process.version, 'v24.19.0')
  assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)
  const manifest = JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url)))
  assert.equal(process.env.EXPECTED_PRODUCT_SHA, manifest.final)
  const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(version.status, 0); assert.equal(version.stdout.trim(), '11.28.5')
  process.exitCode = await inspect(process.argv[2], manifest, join(process.env.RUNNER_TEMP, 'dsh-next-evidence'))
}
