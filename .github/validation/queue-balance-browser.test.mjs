import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TARGETS, PREREQUISITES, exactFilter, assertTarget, assertEnvironment } from './queue-balance-browser.mjs'
import { assertPinned } from './stage2.mjs'
const m = JSON.parse(readFileSync(new URL('./queue-balance-browser-manifest.json', import.meta.url)))
const workflow = readFileSync(new URL('../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
const source = readFileSync(new URL('./queue-balance-browser.mjs', import.meta.url), 'utf8')
const report = (target = TARGETS[0]) => ({ success: true, numTotalTests: 1, numPassedTests: 1, numPendingTests: 0, numFailedTests: 0, testResults: [{ name: '/product/' + target.file, status: 'passed', message: '', assertionResults: [{ title: target.title, fullName: target.suite + ' ' + target.title, status: 'passed', failureMessages: [] }] }] })
const ok = { status: 0, signal: null }
test('exact candidate identity and separate two-test-only commits', () => {
  assertPinned(m)
  assert.equal(m.final, 'fa9e0aa9bc3c881a8c8ad804f5fd33e8beae275b')
  assert.equal(m.base, 'd773e686df9262a62108dfa82b206fa36913c37b')
  assert.equal(m.tree, '166d629ad5035b8ae61067d3f9129979cecd8672')
  assert.deepEqual(m.chain, [{ sha: 'aae6d6530666ec49588b2c0dc26631397be60e14', parent: m.base }, { sha: m.final, parent: 'aae6d6530666ec49588b2c0dc26631397be60e14' }])
  assert.deepEqual(m.files, [
    { path: 'apps/web/tests/account-login.e2e.ts', mode: '100644', blob: '55cc318a336762f3a40f3aa809868438c9c6d5db' },
    { path: 'apps/web/tests/queue-image.e2e.ts', mode: '100644', blob: 'b5db7dcfe7690973bca1b6f60c921547988726c9' },
  ])
})
test('exact target names are scoped to their owning file and suite', () => {
  assert.deepEqual(TARGETS.map(t => t.title), ['recalls only the latest queued image after rejection and ignores repeated ArrowUp', 'signs in, recovers avatars, and refreshes balance through the Account section'])
  for (const target of TARGETS) {
    const re = new RegExp(exactFilter(target))
    assert(re.test(target.suite + ' ' + target.title))
    assert(!re.test(target.suite + ' ' + target.title + ' unrelated'))
    assert(!re.test('other ' + target.title))
    assert.equal(assertTarget(ok, report(target), target).passed, 1)
  }
})
test('zero tests, skipped target, wrong file, duplicate target and wrong suite rejected', () => {
  for (const mutate of [r => r.testResults = [], r => r.testResults[0].assertionResults = [], r => r.testResults[0].assertionResults[0].status = 'skipped', r => r.testResults[0].name = '/product/old-menu.e2e.ts', r => r.testResults[0].assertionResults.push(r.testResults[0].assertionResults[0]), r => r.testResults[0].assertionResults[0].fullName = 'other suite']) {
    const r = report(); mutate(r); assert.throws(() => assertTarget(ok, r, TARGETS[0]))
  }
})
test('process failure, timeout, load errors and extra passing tests fail closed', () => {
  for (const result of [{ status: 1, signal: null }, { status: 0, signal: 'SIGTERM' }, { status: 0, signal: null, error: new Error('timeout') }]) assert.throws(() => assertTarget(result, report(), TARGETS[0]))
  for (const mutate of [r => r.unhandledErrors = ['x'], r => r.numRuntimeErrorTestSuites = 1, r => r.testResults[0].message = 'load failed', r => r.testResults[0].assertionResults.push({ title: 'old menu', status: 'passed' })]) {
    const r = report(); mutate(r); assert.throws(() => assertTarget(ok, r, TARGETS[0]))
  }
})
test('unselected cases are reported separately, never as target passes', () => {
  const r = report(); r.testResults[0].assertionResults.push({ title: 'unrelated old case', status: 'skipped' }); r.numTotalTests = 2; r.numPendingTests = 1
  assert.equal(assertTarget(ok, r, TARGETS[0]).unselected, 1)
})
test('artifacts owns mandatory native once; aggregate and Chromium retained in order', () => {
  assert.deepEqual(PREREQUISITES.map(x => x[0]), ['artifacts', 'aggregate-check', 'chromium-install'])
  assert.deepEqual(PREREQUISITES.map(x => x[2]), [90, 45, 15])
  assert(!PREREQUISITES.some(x => x[1].includes('build:native-system')))
  assert.deepEqual(PREREQUISITES[0][1], ['run', 'build:artifacts'])
  assert(source.includes('mandatory native gate'))
  assert(source.indexOf('of PREREQUISITES') < source.indexOf('of TARGETS'))
  assert(source.includes("'--config=vitest.web.config.ts'")); assert(source.includes("'--maxWorkers=1'"))
})
test('replay and telemetry isolation reject live credentials and local dotenv', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-env-'))
  const env = { DSH_SNAPSHOT: 'replay', DSH_TELEMETRY_DISABLED: '1' }
  try {
    assertEnvironment(env, root)
    for (const bad of [{ ...env, DSH_SNAPSHOT: 'record' }, { ...env, DSH_SNAPSHOT: 'refresh' }, { ...env, DSH_TELEMETRY_DISABLED: '0' }, { ...env, DEEPSEEK_API_KEY: 'synthetic-not-real' }]) assert.throws(() => assertEnvironment(bad, root))
    writeFileSync(join(root, '.env'), ''); assert.throws(() => assertEnvironment(env, root))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('owned process group cleanup is reused, no broad process termination', () => {
  assert(source.includes("import { runCommand } from './run-command.mjs'"))
  const helper = readFileSync(new URL('./run-command.mjs', import.meta.url), 'utf8')
  assert(helper.includes('detached: true')); assert(helper.includes('process.kill(-child.pid, signal)'))
  assert(helper.includes("killGroup('SIGTERM')")); assert(helper.includes("killGroup('SIGKILL')"))
  assert(!/pkill|killall/.test(source + helper))
  assert(source.includes('Final identity:')); assert(source.includes('assert.equal(assertions.length, 2)'))
})
test('workflow preserves exact actions read-only serial scope and complete prerequisites', () => {
  assert.deepEqual([...new Set([...workflow.matchAll(/uses: ([^\n]+)/g)].map(x => x[1]))].sort(), ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1','actions/setup-node@820762786026740c76f36085b0efc47a31fe5020','actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a','pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320'].sort())
  assert.match(workflow, /permissions:\n  contents: read\nconcurrency:\n  group: next-reviewed-heavy-validation\n  cancel-in-progress: false/)
  assert(workflow.includes('fetch-depth: 3')); assert(!workflow.includes('fetch-depth: 0'))
  assert(workflow.includes('run: pnpm install --frozen-lockfile\n')); assert(!workflow.includes('--ignore-scripts'))
  assert(workflow.includes('queue-balance-browser.mjs product --identity-only'))
  assert(workflow.includes('queue-balance-browser.mjs product\n'))
  assert(workflow.includes('queue-balance-heavy-queue.mjs')); assert(workflow.includes('timeout-minutes: 270'))
  assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, 2)
})
test('queue preflight changes only the reviewed main SHA from prior control', () => {
  const old = readFileSync(new URL('./heavy-queue.mjs', import.meta.url), 'utf8')
  const current = readFileSync(new URL('./queue-balance-heavy-queue.mjs', import.meta.url), 'utf8')
  assert.equal(current, old.replace('27b18a0026c569e2072350c552a952483f756436', m.base))
})
