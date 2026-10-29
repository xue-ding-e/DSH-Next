import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSourceHistory, assertTests, manifest, nextSourceTestArgs, verifyIdentity } from './qualification.mjs'

const main = 'apps/desktop/tests/main-startup.spec.ts'
const platform = 'apps/desktop/tests/command-path.spec.ts'
const skippedTitle = 'preserves unrelated PATH entries and rejects stale or foreign removal'
const inventory = {
  [main]: { total: 1, requiredTitles: ['required behavior'], platformSkips: {} },
  [platform]: { total: 1, requiredTitles: [skippedTitle], platformSkips: { linux: [skippedTitle] } },
}
const report = () => ({ success: true, numFailedTests: 0, numTotalTests: 2,
  numPassedTests: 1, numPendingTests: 1, numTodoTests: 0, testResults: [
    { name: '/repo/' + main, assertionResults: [{ title: 'required behavior', status: 'passed' }] },
    { name: '/repo/' + platform, assertionResults: [{ title: skippedTitle, status: 'pending' }] },
  ] })
const check = value => assertTests(value, [main, platform], 'linux', inventory)

test('unsealed source refuses execution before any repository operation', () => {
  assert.throws(() => verifyIdentity('/not-used', { ...manifest, source: null }), /source is not sealed/u)
})
test('Next source tests explicitly transform TypeScript constructor parameter properties', () => {
  assert.deepEqual(nextSourceTestArgs, ['--experimental-transform-types', '--test', '--test-reporter=tap', '.github/validation/next-desktop.test.mjs'])
})
test('foreign repository, workflow SHA, product SHA, ref and runner refuse before filesystem access', () => {
  const sha = 'a'.repeat(40)
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: manifest.repository, GITHUB_REPOSITORY_ID: manifest.repositoryId, GITHUB_REF: manifest.controlRef,
    GITHUB_SHA: sha, EXPECTED_CONTROL_SHA: sha, GITHUB_WORKFLOW_SHA: sha, EXPECTED_PRODUCT_SHA: manifest.source }
  for (const key of ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'EXPECTED_PRODUCT_SHA', 'RUNNER_ENVIRONMENT']) {
    assert.throws(() => verifyIdentity('/not-used', manifest, { ...env, [key]: 'foreign' }), assert.AssertionError, key)
  }
})
test('declared platform skips are separately recorded and all counters agree with real assertions', () => {
  assert.deepEqual(check(report()).map(item => item.title), [skippedTitle])
  assert.throws(() => assertTests(report(), [main, platform], 'win32', inventory))
})
test('empty, missing, failed, runtime-error and unhandled-error evidence never qualifies', () => {
  for (const mutate of [r => { r.testResults = [] }, r => { r.testResults[0].assertionResults = [] },
    r => { r.testResults[0].assertionResults[0].status = 'failed' }, r => { r.numRuntimeErrorTestSuites = 1 },
    r => { r.unhandledErrors = ['failure'] }, r => { r.numFailedTests = 1 }]) {
    const value = report(); mutate(value); assert.throws(() => check(value))
  }
})
test('fabricated pass counters, missing required cases and unknown skipped titles are rejected', () => {
  for (const mutate of [r => { r.numPassedTests++ }, r => { r.numTotalTests-- }, r => { r.numPendingTests = 0 },
    r => { r.testResults[0].assertionResults[0].title = 'unrelated behavior' },
    r => { r.testResults[1].assertionResults[0].title = 'unknown skipped title' },
    r => { r.testResults[0].assertionResults[0].status = 'pending'; r.numPassedTests = 0; r.numPendingTests = 2 }]) {
    const value = report(); mutate(value); assert.throws(() => check(value))
  }
})
test('a skipped-only file with a fabricated positive pass count is not evidence', () => {
  const value = report(); value.testResults.shift(); value.numTotalTests = 1
  assert.throws(() => assertTests(value, [platform], 'linux', inventory))
})
test('the locked source inventory contains 204 Desktop cases, five Linux skips and 157 + 2 pointer cases', () => {
  assert.equal(manifest.desktopTests.length, 10)
  assert.equal(manifest.candidatePaths.length, 44)
  assert.equal(Object.keys(manifest.files).length, 59)
  assert.equal(manifest.desktopTests.reduce((sum, path) => sum + manifest.testInventory[path].total, 0), 204)
  assert.equal(manifest.desktopTests.reduce((sum, path) => sum + (manifest.testInventory[path].platformSkips.linux?.length ?? 0), 0), 5)
  assert.equal(manifest.pointerTests.reduce((sum, path) => sum + manifest.testInventory[path].total, 0), 157)
  assert.equal(manifest.testInventory[manifest.pointerBrowser].total, 2)
  for (const path of [...manifest.desktopTests, ...manifest.pointerTests, manifest.pointerBrowser]) assert(manifest.files[path])
})
test('the two-file smoke hardening preserves its exact parent tree, feature base and cumulative scope', () => {
  const actual = { parent: manifest.parent, parentTree: manifest.parentTree, scopeBase: manifest.scopeBase,
    cumulativePaths: [...manifest.candidatePaths], fixPaths: [...manifest.sourceFixPaths] }
  assertSourceHistory(actual)
  assert.equal(manifest.parent, '7b622408018241a14165b94a76ca57f1d279266e')
  assert.equal(manifest.parentTree, '6b46735ce7ef0805bd621cfa712a5ecc740a2a82')
  assert.equal(manifest.scopeBase, '33b096719d52a84b931184c22e8a3a321550972f')
  assert.deepEqual(manifest.sourceFixPaths, ['apps/desktop/scripts/smoke-runtime.ts', 'apps/desktop/tests/prepared-runtime-smoke.spec.ts'])
  for (const key of ['parent', 'parentTree', 'scopeBase']) assert.throws(() => assertSourceHistory({ ...actual, [key]: '0'.repeat(40) }))
  assert.throws(() => assertSourceHistory({ ...actual, cumulativePaths: actual.cumulativePaths.slice(1) }))
  assert.throws(() => assertSourceHistory({ ...actual, fixPaths: [...actual.fixPaths, 'unexpected-product-file.ts'] }))
})
test('the separate smoke-profile owner must pass all three actual cases with no skipped assertion', () => {
  const path = 'apps/desktop/tests/prepared-runtime-smoke.spec.ts'
  assert.deepEqual(manifest.smokeTests, [path])
  const specification = manifest.testInventory[path]
  assert.equal(specification.total, 3)
  assert.equal(specification.requiredTitles.length, 3)
  assert.deepEqual(specification.platformSkips, {})
  assert(manifest.files[path])
  const value = { success: true, numFailedTests: 0, numTotalTests: 3, numPassedTests: 3, numPendingTests: 0,
    testResults: [{ name: '/repo/' + path, assertionResults: specification.requiredTitles.map(title => ({ title, status: 'passed' })) }] }
  assert.deepEqual(assertTests(value, manifest.smokeTests, 'linux'), [])
  assert.deepEqual(assertTests(value, manifest.smokeTests, 'win32'), [])
  value.testResults[0].assertionResults[2].status = 'pending'; value.numPassedTests--; value.numPendingTests++
  assert.throws(() => assertTests(value, manifest.smokeTests, 'linux'))
})
