import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TARGETS, PREREQUISITES, exactFilter, assertTarget, assertEnvironment } from './queue-balance-browser.mjs'
import { assertPinned } from './stage2.mjs'
import { CC_EVIDENCE, assertCcPredecessor } from './queue-balance-heavy-queue.mjs'
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
test('queue retains other predecessor and active-run gates while binding reviewed CC evidence', () => {
  const old = readFileSync(new URL('./heavy-queue.mjs', import.meta.url), 'utf8')
  const current = readFileSync(new URL('./queue-balance-heavy-queue.mjs', import.meta.url), 'utf8')
  assert.equal(current.slice(0, current.indexOf('/** Independently downloaded receipt')), old.slice(0, old.indexOf('/** Release the CC slot')))
  assert.equal(current.slice(current.indexOf('    // This is a fail-closed preflight')), old.slice(old.indexOf('    // This is a fail-closed preflight')))
  assert(current.includes(m.base))
  assert(current.includes('assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)'))
  assert(current.includes("assert.match(process.env.EXPECTED_CONTROL_SHA ?? '', /^[0-9a-f]{40}$/)"))
  assert(current.includes('assertCcPredecessor(run, jobs, artifact)'))
  assert(!current.includes('40602600351'))
})
function ccFixture() {
  return {
    run: { id: 40751857975, repository: { full_name: 'xue-ding-e/CC-Switch-Next' }, head_sha: CC_EVIDENCE.controlSha,
      head_branch: 'validation/minimax-8124-20261028', path: '.github/workflows/cloud-validation.yml', workflow_id: 386700965,
      event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion: 'success' },
    jobs: { total_count: 1, jobs: [{ id: 123040368342, name: 'parser', status: 'completed', conclusion: 'success',
      steps: [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17].map(number => ({ number, status: 'completed', conclusion: 'success',
        name: number === 7 ? 'Compile once and verify actual parser tests' : number === 8 ? 'Upload bounded verification evidence (not binaries)' : 'fixture step' })) }] },
    artifact: { id: 12845390567, name: 'minimax-validation-40751857975-1', expired: false, digest: CC_EVIDENCE.artifactDigest,
      workflow_run: { id: 40751857975, head_sha: CC_EVIDENCE.controlSha, head_branch: 'validation/minimax-8124-20261028' } },
  }
}
test('CC gate distinguishes reviewed control SHA from actual source and pinned receipt bytes', () => {
  assert.equal(CC_EVIDENCE.controlSha, '461f99855f37cb25acc5524b5e84c920170c4a1f')
  assert.equal(CC_EVIDENCE.sourceSha, 'bd416383d971e302ed059ae7ada73fd57429ab26')
  assert.equal(CC_EVIDENCE.receiptPath, 'minimax-evidence/receipt.json')
  assert.equal(CC_EVIDENCE.receiptSha256, 'dffed32a9a437613861a1d58c1b889241cd27a917516057da75ccace5750213e')
  assert.equal(CC_EVIDENCE.tests, 7)
  assert.equal(CC_EVIDENCE.inventoryCount, 3740)
  const f = ccFixture(); assertCcPredecessor(f.run, f.jobs, f.artifact)
})
test('green CC summary cannot substitute for exact attempt, parser steps, or reviewed artifact', () => {
  for (const mutate of [
    f => f.run.head_sha = CC_EVIDENCE.sourceSha,
    f => f.run.id = 40602600351,
    f => f.run.run_attempt = 2,
    f => f.run.event = 'push',
    f => f.run.conclusion = 'failure',
    f => f.jobs.total_count = 2,
    f => f.jobs.jobs = [],
    f => f.jobs.jobs[0].name = 'synthetic-control-only',
    f => f.jobs.jobs[0].steps[6].conclusion = 'skipped',
    f => f.jobs.jobs[0].steps[6].name = 'No actual parser tests',
    f => f.jobs.jobs[0].steps.pop(),
    f => f.artifact.expired = true,
    f => f.artifact.id = 1,
    f => f.artifact.digest = 'sha256:' + '0'.repeat(64),
    f => f.artifact.workflow_run.head_sha = CC_EVIDENCE.sourceSha,
    f => f.artifact.workflow_run.id = 1,
  ]) {
    const f = ccFixture(); mutate(f)
    assert.throws(() => assertCcPredecessor(f.run, f.jobs, f.artifact))
  }
})
