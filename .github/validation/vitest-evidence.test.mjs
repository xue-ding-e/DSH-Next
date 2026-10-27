import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertNegativeControl, assertWorkspaceNegativeControl, WORKSPACE_REGRESSION, assertPassing, BROWSER_FILE, BROWSER_TEST, REGRESSION, ROW_TEST, UNIT_FILES } from './vitest-evidence.mjs'

const exited = status => ({ status, signal: null, error: undefined })
const assertion = (title, status = 'passed') => ({ title, status, failureMessages: [] })
const file = (name, assertions) => ({ name: `/runner/product/${name}`, assertionResults: assertions })
const negative = () => ({
  success: false, numFailedTests: 2, numPassedTests: 0, numRuntimeErrorTestSuites: 0,
  testResults: [file(ROW_TEST, [false, true].map(archived => ({
    title: `${REGRESSION} (archived=${archived})`, status: 'failed',
    failureMessages: ['AssertionError: expected true to be false // Object.is equality\n at rows.client.spec.tsx:1079:46'],
  })))],
})
const passing = () => ({
  success: true, numFailedTests: 0, numPassedTests: UNIT_FILES.length,
  numPendingTests: 0, numTodoTests: 0,
  testResults: UNIT_FILES.map(name => file(name, [assertion(`${name} behavior`)])),
})

test('accepts only the two intended assertion failures', () => assertNegativeControl(exited(1), negative()))
test('allows explicitly unselected cases without counting them as evidence', () => {
  const report = negative()
  report.testResults[0].assertionResults.push(assertion('unselected case', 'pending'))
  assertNegativeControl(exited(1), report)
})
for (const [name, mutate] of [
  ['zero selected tests', report => { report.testResults[0].assertionResults = [] }],
  ['wrong failure cause', report => { report.testResults[0].assertionResults[0].failureMessages = ['Cannot find package vitest'] }],
  ['wrong assertion location', report => { report.testResults[0].assertionResults[0].failureMessages[0] = 'AssertionError: expected true to be false\nrows.client.spec.tsx:900:1' }],
  ['skipped regression', report => { report.testResults[0].assertionResults[0].status = 'pending' }],
  ['one archived state only', report => { report.testResults[0].assertionResults.pop() }],
  ['unexpected extra failure', report => { report.numFailedTests = 3 }],
  ['runtime error', report => { report.numRuntimeErrorTestSuites = 1 }],
  ['unhandled rejection', report => { report.unhandledErrors = ['late rejection'] }],
  ['file-level setup failure', report => { report.testResults[0].message = 'beforeAll failed' }],
  ['second failure in selected case', report => { report.testResults[0].assertionResults[0].failureMessages.push('teardown failed') }],
]) {
  test(`rejects negative control: ${name}`, () => {
    const report = negative(); mutate(report)
    assert.throws(() => assertNegativeControl(exited(1), report))
  })
}
test('rejects signal termination', () => assert.throws(() => assertNegativeControl({ status: null, signal: 'SIGTERM' }, negative())))
test('rejects timeout errors', () => assert.throws(() => assertNegativeControl({ ...exited(1), error: new Error('ETIMEDOUT') }, negative())))
test('rejects a successful before run', () => assert.throws(() => assertNegativeControl(exited(0), negative())))
test('accepts all reviewed genuine passing files', () => assertPassing(exited(0), passing(), UNIT_FILES))
for (const [name, mutate] of [
  ['missing file', report => { report.testResults.pop() }],
  ['empty suite', report => { report.testResults[0].assertionResults = [] }],
  ['skipped test', report => { report.testResults[0].assertionResults[0].status = 'pending' }],
  ['false passed count', report => { report.numPassedTests = 0 }],
]) {
  test(`rejects positive evidence: ${name}`, () => {
    const report = passing(); mutate(report)
    assert.throws(() => assertPassing(exited(0), report, UNIT_FILES))
  })
}
test('browser evidence requires its exact owned case to pass', () => {
  const report = { success: true, numFailedTests: 0, numPassedTests: 1,
    testResults: [file(BROWSER_FILE, [assertion(BROWSER_TEST), assertion('unselected original browser case', 'pending')])] }
  assertPassing(exited(0), report, [BROWSER_FILE], [BROWSER_TEST])
  report.testResults[0].assertionResults[0].status = 'pending'
  assert.throws(() => assertPassing(exited(0), report, [BROWSER_FILE], [BROWSER_TEST]))
})

test('rejects an unhandled-error console section beside expected failures', () => assert.throws(() => assertNegativeControl({ ...exited(1), output: 'Unhandled Errors: late rejection' }, negative())))

const { assertAiPredecessor, assertMagpiePredecessor, assertFlutterPredecessor, assertStaleRunIsQuiescent, isCurrentValidationRun, STALE_RUN_ID, STALE_JOB_ID } = await import('./heavy-queue.mjs')
const stale = () => ({
  run: { id: STALE_RUN_ID, status: 'in_progress', conclusion: null, run_attempt: 1,
    head_sha: '2945e5f54370b10cca6fe0e0253833a719a02054', updated_at: '2026-10-22T00:14:01Z' },
  jobs: { total_count: 1, jobs: [{ id: STALE_JOB_ID, status: 'completed', conclusion: 'failure',
    completed_at: '2026-10-22T00:14:52Z', steps: [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17].map(number => ({
      number, status: 'completed', conclusion: number === 7 ? 'failure' : 'success', completed_at: '2026-10-22T00:14:50Z',
    })) }] },
})
test('accepts only the exact verified stale run after complete terminal job/step evidence', () => {
  const value = stale(); assertStaleRunIsQuiescent('xue-ding-e/XenTerm-Next', value.run, value.jobs)
})
for (const [name, mutate] of [
  ['another run', value => { value.run.id += 1 }],
  ['new run attempt', value => { value.run.run_attempt = 2 }],
  ['updated metadata', value => { value.run.updated_at = '2026-10-27T00:00:00Z' }],
  ['partial job inventory', value => { value.jobs.total_count = 2 }],
  ['different job', value => { value.jobs.jobs[0].id += 1 }],
  ['running job', value => { value.jobs.jobs[0].status = 'in_progress' }],
  ['running step', value => { value.jobs.jobs[0].steps[0].status = 'in_progress' }],
  ['missing step evidence', value => { value.jobs.jobs[0].steps.pop() }],
]) {
  test(`rejects stale-run exception: ${name}`, () => {
    const value = stale(); mutate(value)
    assert.throws(() => assertStaleRunIsQuiescent('xue-ding-e/XenTerm-Next', value.run, value.jobs))
  })
}

test('only the exact current validation is excluded from the DSH background-work gate', () => {
  const run = { id: 123, event: 'workflow_dispatch', path: '.github/workflows/next-context-menu-validation.yml',
    head_branch: 'validation/workspace-open-folder', head_sha: 'a'.repeat(40) }
  assert.equal(isCurrentValidationRun('xue-ding-e/DSH-Next', run, '123', 'a'.repeat(40)), true)
  assert.equal(isCurrentValidationRun('xue-ding-e/DSH-Next', { ...run, id: 124 }, '123', 'a'.repeat(40)), false)
  assert.equal(isCurrentValidationRun('xue-ding-e/DSH-Next', { ...run, event: 'dynamic' }, '123', 'a'.repeat(40)), false)
  assert.equal(isCurrentValidationRun('xue-ding-e/DSH-Next', { ...run, head_sha: 'b'.repeat(40) }, '123', 'a'.repeat(40)), false)
})

const workspaceNegative = () => ({
  success: false, numFailedTests: 1, numPassedTests: 0, numRuntimeErrorTestSuites: 0,
  testResults: [file(ROW_TEST, [{ title: WORKSPACE_REGRESSION, status: 'failed',
    failureMessages: ['AssertionError: expected false to be true\n at rows.client.spec.tsx:704:36'] }])],
})
test('accepts only the workspace context-menu reproduction', () => assertWorkspaceNegativeControl(exited(1), workspaceNegative()))
for (const [name, mutate] of [
  ['wrong location', r => { r.testResults[0].assertionResults[0].failureMessages[0] = 'AssertionError: expected false to be true\nrows.client.spec.tsx:100:1' }],
  ['wrong case', r => { r.testResults[0].assertionResults[0].title = 'unrelated' }],
  ['extra failure', r => { r.numFailedTests = 2 }],
  ['skipped case', r => { r.testResults[0].assertionResults[0].status = 'pending' }],
  ['runtime error', r => { r.numRuntimeErrorTestSuites = 1 }],
  ['unhandled rejection', r => { r.unhandledErrors = ['late'] }],
  ['setup failure', r => { r.testResults[0].message = 'failed to load' }],
]) {
  test(`rejects workspace negative control: ${name}`, () => { const r = workspaceNegative(); mutate(r); assert.throws(() => assertWorkspaceNegativeControl(exited(1), r)) })
}

const flutter = () => ({ id: 40566861374, repository: { full_name: 'xue-ding-e/XenTerm' },
  head_sha: '4da4327fc06d231ef3c867ceac6a63472895e871', head_branch: 'validation/linux-ui-flows-v2',
  path: '.github/workflows/flutter-linux-ui-validation.yml', event: 'push', run_attempt: 1,
  status: 'completed', conclusion: 'success' })
test('accepts the exact terminal reviewed Flutter Linux predecessor', () => assertFlutterPredecessor(flutter(), '4da4327fc06d231ef3c867ceac6a63472895e871'))
for (const [field, value] of [['repository', { full_name: 'xue-ding-e/Other' }], ['head_sha', 'a'.repeat(40)], ['head_branch', 'main'],
  ['path', '.github/workflows/flutter-mac.yml'], ['status', 'in_progress'], ['conclusion', null], ['event', 'workflow_dispatch']]) {
  test(`rejects changed Flutter predecessor ${field}`, () => assert.throws(() => assertFlutterPredecessor({ ...flutter(), [field]: value }, '4da4327fc06d231ef3c867ceac6a63472895e871')))
}

const ai = () => ({ id: 40481574537, repository: { full_name: 'xue-ding-e/AI-Toolbox-Next' },
  head_sha: '0ada44a14ec24485f58fd4f5ff02c776b58d4d42', head_branch: 'fix/codex-fetched-model-picker-20261027',
  path: '.github/workflows/maintenance-validation.yml', workflow_id: 386744123, event: 'workflow_dispatch',
  run_attempt: 1, status: 'completed', conclusion: 'success' })
const magpie = () => ({ repository: { full_name: 'xue-ding-e/Magpie-Next' },
  head_sha: '6f2f1e11e2d06bb33984b0e01c94505051409864', head_branch: 'security/compress1187-gzip-contract',
  path: '.github/workflows/test.yml', workflow_id: 393373719, event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success' })
test('accepts exact successful AI predecessor and terminal exact-source Magpie predecessor', () => {
  assertAiPredecessor(ai()); assertMagpiePredecessor(magpie(), '6f2f1e11e2d06bb33984b0e01c94505051409864')
  assertMagpiePredecessor({ ...magpie(), conclusion: 'failure' }, '6f2f1e11e2d06bb33984b0e01c94505051409864')
})
for (const [name, make, check] of [['AI', ai, assertAiPredecessor], ['Magpie', magpie, run => assertMagpiePredecessor(run, '6f2f1e11e2d06bb33984b0e01c94505051409864')]]) {
  for (const [field, value] of [['head_sha', 'a'.repeat(40)], ['head_branch', 'main'], ['workflow_id', 1],
    ['path', '.github/workflows/another.yml'], ['status', 'in_progress'], ['conclusion', null]]) {
    test(`rejects changed ${name} predecessor ${field}`, () => assert.throws(() => check({ ...make(), [field]: value })))
  }
}

test('Magpie requires a separately supplied exact SHA and rejects absent or mismatched values', () => {
  assert.throws(() => assertMagpiePredecessor(magpie()))
  assert.throws(() => assertMagpiePredecessor(magpie(), 'a'.repeat(40)))
  assert.throws(() => assertMagpiePredecessor(magpie(), '6f2f1e1'))
})

for (const expectedSha of [undefined, '4da4327', 'g'.repeat(40), 'a'.repeat(40)]) {
  test(`Flutter rejects absent, malformed or mismatched independent SHA: ${expectedSha}`, () => {
    assert.throws(() => assertFlutterPredecessor(flutter(), expectedSha))
  })
}
test('Flutter terminal failure releases only the resource slot, including a reviewed retry', () => {
  assertFlutterPredecessor({ ...flutter(), run_attempt: 2, conclusion: 'failure' }, '4da4327fc06d231ef3c867ceac6a63472895e871')
})
