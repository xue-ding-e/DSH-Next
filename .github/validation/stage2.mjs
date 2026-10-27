import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export function assertPinned(m) {
  assert.match(m.final, /^[0-9a-f]{40}$/)
  assert.match(m.base, /^[0-9a-f]{40}$/)
  assert.match(m.tree, /^[0-9a-f]{40}$/)
  assert.equal(m.chain.at(-1)?.sha, m.final)
  let parent = m.base
  for (const item of m.chain) {
    assert.match(item.sha, /^[0-9a-f]{40}$/)
    assert.equal(item.parent, parent)
    parent = item.sha
  }
  assert(m.files.length > 0)
  for (const file of m.files) {
    assert.match(file.blob, /^[0-9a-f]{40}$/)
    assert.match(file.mode, /^100(644|755)$/)
    assert(!file.path.startsWith('/') && !file.path.split('/').includes('..'))
  }
  assert.equal(new Set(m.files.map(f => f.path)).size, m.files.length)
}
export function assertReport(report, expected) {
  assert.equal(report.success, true)
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0)
  assert.equal(report.unhandledErrors?.length ?? 0, 0)
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numPendingTests ?? 0, 0)
  assert.equal(report.numTodoTests ?? 0, 0)
  assert.equal(report.testResults.length, expected.length)
  let count = 0
  for (const file of expected) {
    const matches = report.testResults.filter(r => r.name.replaceAll('\\', '/').endsWith('/' + file))
    assert.equal(matches.length, 1, `missing/duplicate file: ${file}`)
    assert.equal(matches[0].status, 'passed')
    assert.equal(matches[0].message ?? '', '')
    assert(matches[0].assertionResults.length > 0, `empty suite: ${file}`)
    for (const test of matches[0].assertionResults) assert.equal(test.status, 'passed', `${file}: ${test.fullName}`)
    count += matches[0].assertionResults.length
  }
  assert.equal(report.numTotalTests, count)
  assert.equal(report.numPassedTests, count)
  return count
}
export function verify(root, m) {
  assertPinned(m)
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  assert.equal(git('rev-parse', 'HEAD'), m.final)
  assert.equal(git('rev-parse', 'HEAD^{tree}'), m.tree)
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '')
  assert.equal(git('merge-base', m.base, m.final), m.base)
  const chain = git('rev-list', '--reverse', '--parents', `${m.base}..${m.final}`).split('\n').map(line => {
    const [sha, parent, ...extra] = line.split(' ')
    assert.equal(extra.length, 0, 'merge commit forbidden')
    return { sha, parent }
  })
  assert.deepEqual(chain, m.chain)
  // Exact range plus blobs/modes is stronger than a permissive filename whitelist.
  const paths = git('diff', '--name-only', '--no-renames', m.base, m.final).split('\n').filter(Boolean).sort()
  assert.deepEqual(paths, m.files.map(f => f.path).sort())
  for (const file of m.files) assert.equal(git('ls-tree', m.final, '--', file.path), `${file.mode} blob ${file.blob}\t${file.path}`)
}
function main() {
  const root = resolve(process.argv[2])
  const m = JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url)))
  const evidence = join(process.env.RUNNER_TEMP, 'dsh-next-evidence')
  mkdirSync(evidence, { recursive: true })
  assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)
  assert.equal(process.env.EXPECTED_PRODUCT_SHA, m.final)
  assert.equal(process.version, 'v24.19.0')
  verify(root, m)
  if (process.argv.includes('--identity-only')) return
  const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), '11.28.5')
  const results = []
  const run = (label, args, minutes) => {
    const out = openSync(join(evidence, `${label}.stdout`), 'w')
    const err = openSync(join(evidence, `${label}.stderr`), 'w')
    let r
    try { r = spawnSync('pnpm', args, { cwd: root, timeout: minutes * 60_000, stdio: ['ignore', out, err] }) }
    finally { closeSync(out); closeSync(err) }
    results.push({ label, args, status: r.status, signal: r.signal, error: r.error?.message })
    assert.equal(r.error, undefined, `${label} timed out/process failed`)
    assert.equal(r.signal, null, `${label} terminated`)
    assert.equal(r.status, 0, `${label} failed; see evidence`)
  }
  let failure, assertionCount
  try {
    run('native-prerequisite', ['run', 'build:native-system'], 20)
    const reportPath = join(evidence, 'focused.json')
    run('focused', ['exec', 'vitest', 'run', ...m.tests, '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`], 45)
    assertionCount = assertReport(JSON.parse(readFileSync(reportPath)), m.tests)
    run('artifacts', ['run', 'build:artifacts'], 90)
    run('aggregate-check', ['run', 'build:check'], 45)
    run('chromium-install', ['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], 15)
    run('context-menu-browser', ['exec', 'node', new URL('./context-menu-browser.mjs', import.meta.url).pathname, root, evidence], 55)
    for (const script of ['verify-cordis-catalog', 'verify-cordis-inspect-catalog', 'verify-persistence-catalog', 'verify-persistence-changes', 'verify-persistence-formats']) run(script, ['run', script], 10)
    run('doc-sync', ['run', 'doc-sync'], 30)
  } catch (error) { failure = error.message; process.exitCode = 1 }
  finally {
    try { verify(root, m) } catch (error) { failure = `${failure ?? ''}\nFinal identity: ${error.message}`; process.exitCode = 1 }
    writeFileSync(join(evidence, 'stage2-result.json'), JSON.stringify({ source: m.final, base: m.base, control: process.env.GITHUB_SHA, node: process.version, results, assertionCount, failure, validated: !failure, scope: 'Linux locked-toolchain focused fixtures, Loader/JSONL test and build/doc gates; real Chromium session/workspace menus with synthetic OS opener; queue/balance browser interactions remain uncovered; not native desktop UI, full coverage, installer, release or deployment' }, null, 2))
  }
}
if (import.meta.main) main()
