import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCommand } from './run-command.mjs'
import { assertPassing } from './vitest-evidence.mjs'

const rows = 'packages/client/ui-workspace/tests/rows.client.spec.tsx'
const atoms = 'packages/client/ui-primitives/tests/atoms.client.spec.tsx'
const browser = 'apps/web/tests/row-context-menu.e2e.ts'
const productions = ['packages/client/ui-workspace/src/client/rows/Rows.tsx', 'packages/client/ui-primitives/src/Menu.tsx']
export const rowTitles = ['workspace', 'session'].map(kind => `places the ${kind} menu at each pointer request without selecting the row`)
export const timerTitle = 'disarms a pending grace close when pointer-leave dismissal is disabled while open'
export const browserTitles = ['workspace', 'session'].map(kind => `keeps the ${kind} menu at its requested anchor with dismissal and focus return`)

/** Accept only the selected behavioral assertions, never compile/load errors or skipped cases. */
export function assertRed(result, report, file, titles, detailPattern, locationPattern) {
  assert.equal(result.status, 1); assert.equal(result.signal, null); assert.equal(result.error, undefined)
  assert.equal(report.success, false); assert.equal(report.numFailedTests, titles.length)
  assert.equal(report.numPassedTests, 0); assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0)
  assert.equal(report.unhandledErrors?.length ?? 0, 0)
  assert.equal(report.testResults.length, 1)
  const suite = report.testResults[0]
  assert(suite.name.replaceAll('\\', '/').endsWith('/' + file)); assert.equal(suite.message ?? '', '')
  assert.doesNotMatch(result.output, /Unhandled (?:Errors?|Rejections?|Exceptions?)|unhandledRejection|ERR_UNHANDLED_REJECTION/i)
  for (const title of titles) {
    const selected = suite.assertionResults.filter(t => t.title === title)
    assert.equal(selected.length, 1)
    const test = selected[0]; assert.equal(test.status, 'failed'); assert.equal(test.failureMessages.length, 1)
    const detail = test.failureMessages[0].replace(/\u001b\[[0-9;]*m/g, '')
    assert.match(detail, /AssertionError/); assert.match(detail, detailPattern); assert.match(detail, locationPattern)
    assert.doesNotMatch(detail, /(?:Error: [^\n]*(?:timed?\s*out|timeout)|\b(?:Test|Hook) timed out\b)|Cannot find|Failed to resolve|SyntaxError|ReferenceError|TypeError|beforeAll|afterAll|beforeEach|afterEach|hook failed|hook timeout/i)
  }
  for (const test of suite.assertionResults.filter(t => !titles.includes(t.title))) assert(['pending', 'skipped', 'disabled'].includes(test.status))
}

async function main() {
  const root = resolve(process.argv[2]); const evidence = join(process.env.RUNNER_TEMP, 'dsh-pointer-evidence')
  mkdirSync(evidence, { recursive: true })
  const m = JSON.parse(readFileSync(new URL('./pointer-menu-manifest.json', import.meta.url)))
  const git = (...args) => execFileSync('git', args, { cwd: root })
  const text = (...args) => git(...args).toString().trim()
  const verify = () => {
    assert.equal(process.env.GITHUB_REPOSITORY, m.repository); assert.equal(process.env.GITHUB_REPOSITORY_ID, m.repositoryId)
    assert.match(process.env.EXPECTED_CONTROL_SHA ?? '', /^[0-9a-f]{40}$/)
    assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)
    assert.equal(process.env.EXPECTED_PRODUCT_SHA, m.source)
    assert.equal(text('rev-parse', 'HEAD'), m.source); assert.equal(text('rev-parse', 'HEAD^{tree}'), m.tree)
    assert.equal(text('rev-parse', m.source + '^'), m.fixture); assert.equal(text('rev-parse', m.fixture + '^'), m.product); assert.equal(text('rev-parse', m.product + '^'), m.docs); assert.equal(text('rev-parse', m.docs + '^'), m.base)
    assert.equal(text('rev-parse', m.base + '^'), m.redBase)
    assert.deepEqual(text('diff', '--name-only', m.base, m.docs).split('\n'), m.docsPaths)
    assert.deepEqual(text('diff', '--name-only', m.docs, m.product).split('\n'), m.productPaths)
    assert.deepEqual(text('diff', '--name-only', m.product, m.fixture).split('\n'), m.fixturePaths)
    assert.deepEqual(text('diff', '--name-only', m.fixture, m.source).split('\n'), m.fixPaths)
    assert.equal(text('diff', '--name-only'), ''); assert.equal(text('diff', '--cached', '--name-only'), '')
    for (const [path, hash] of Object.entries(m.sha256)) assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), hash)
  }
  assert.equal(process.version, 'v24.19.0'); assert.equal(process.env.DSH_SNAPSHOT, 'replay')
  assert.equal(process.env.DSH_TELEMETRY_DISABLED, '1'); assert(!existsSync(join(root, '.env')))
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) assert(!process.env[key])
  verify()
  if (process.argv.includes('--identity-only')) return
  const stages = []; let failure
  async function command(label, args, minutes, mayFail = false) {
    const result = await runCommand('pnpm', args, { cwd: root, timeout: minutes * 60_000, env: { ...process.env, NO_COLOR: '1' } })
    writeFileSync(join(evidence, label + '.log'), result.output)
    stages.push({ label, args, status: result.status, signal: result.signal, error: result.error?.message })
    assert.equal(result.error, undefined); assert.equal(result.signal, null)
    if (!mayFail) assert.equal(result.status, 0, label)
    return result
  }
  async function test(label, files, titleFilter, isBrowser = false, mayFail = false) {
    const output = join(evidence, label + '.json')
    const result = await command(label, ['exec', 'vitest', 'run', ...(isBrowser ? ['--config=vitest.web.config.ts'] : ['--project=thread-safe']), ...files,
      ...(titleFilter ? ['-t', titleFilter] : []), '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + output], 15, mayFail)
    return [result, JSON.parse(readFileSync(output))]
  }
  try {
    const version = await command('pnpm-version', ['--version'], 1); assert.equal(version.output.trim(), '11.28.5')
    const saved = productions.map(path => readFileSync(join(root, path)))
    try {
      productions.forEach(path => writeFileSync(join(root, path), git('show', `${m.redBase}:${path}`)))
      const [r, report] = await test('rows-red', [rows], 'places the (workspace|session) menu at each pointer request without selecting the row', false, true)
      assertRed(r, report, rows, rowTitles, /AssertionError: expected '250px' to be '100px'/, /rows\.client\.spec\.tsx:1715:\d+/)
      const [t, timer] = await test('timer-red', [atoms], timerTitle, false, true)
      assertRed(t, timer, atoms, [timerTitle], /AssertionError: expected [^\n]+ to not be called at all/, /atoms\.client\.spec\.tsx:467:\d+/)
    } finally {
      productions.forEach((path, i) => writeFileSync(join(root, path), saved[i]))
      verify()
    }
    const [green, unit] = await test('unit-green', [rows, atoms]); assertPassing(green, unit, [rows, atoms]); verify()
    await command('artifacts', ['run', 'build:artifacts'], 90); verify()
    await command('build-check', ['run', 'build:check'], 45); verify()
    await command('doc-sync', ['run', 'doc-sync'], 30); verify()
    await command('chromium', ['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], 15)
    const [web, report] = await test('browser', [browser], undefined, true)
    assertPassing(web, report, [browser]); assert.equal(report.numPassedTests, 2)
    for (const title of browserTitles) assert.equal(report.testResults[0].assertionResults.filter(t => t.title === title && t.status === 'passed').length, 1)
    verify()
  } catch (error) { failure = error.message; process.exitCode = 1 }
  finally {
    try { verify() } catch (error) { failure = (failure ?? '') + '\nFinal identity: ' + error.message; process.exitCode = 1 }
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ repositoryId: m.repositoryId, source: m.source, fixture: m.fixture, product: m.product, base: m.base, redBase: m.redBase, docs: m.docs,
      tree: m.tree, control: process.env.GITHUB_SHA, stages, failure, validated: !failure,
      scope: 'Real jsdom owner tests and Chromium shipped Web/Host with synthetic seeded sessions; not native desktop, real credentials, full 13-goal coverage or release' }, null, 2) + '\n')
  }
}
if (import.meta.main) await main()
