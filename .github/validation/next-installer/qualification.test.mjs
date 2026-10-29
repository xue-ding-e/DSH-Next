import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { assertExtensionNodeReport, assertPreservedMainFiles, assertSelectedTestReport, assertSourceHistory, assertTests, manifest, nextSourceTestArgs, verifyIdentity } from './qualification.mjs'

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
  assert.throws(() => verifyIdentity('/not-used', manifest, { ...env, DSH_TEST_RUNTIME: '/never-open-this-profile' }), /ambient Harness runtime/u)
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
test('separate fixture and smoke commits retain both exact parents, trees and cumulative scope', () => {
  const actual = { parent: manifest.parent, parentTree: manifest.parentTree, scopeBase: manifest.scopeBase,
    smokeParent: manifest.smokeParent, smokeParentTree: manifest.smokeParentTree,
    cumulativePaths: [...manifest.candidatePaths], fixPaths: [...manifest.sourceFixPaths], smokePaths: [...manifest.smokeFixPaths] }
  assertSourceHistory(actual)
  assert.equal(manifest.parent, '80312d6a370975de8ef5f00f23bf500916b77d2c')
  assert.equal(manifest.parentTree, 'bd84ba608c6e1eca59b9b14d6475f22577c96c56')
  assert.equal(manifest.smokeParent, '3daa518147836fc7ddf36e5cbc15a986f67914bf')
  assert.equal(manifest.smokeParentTree, '4a1a41a056730d07b47261994343f3a63422fc61')
  assert.equal(manifest.scopeBase, 'de4685da5e893765fce7ec5e590f13dd6f051803')
  assert.deepEqual(manifest.sourceFixPaths, ['.github/validation/next-desktop.test.mjs', 'apps/desktop/tests/main-startup.spec.ts'])
  assert.deepEqual(manifest.smokeFixPaths, ['apps/desktop/scripts/smoke-runtime.ts', 'apps/desktop/tests/prepared-runtime-smoke.spec.ts'])
  for (const key of ['parent', 'parentTree', 'smokeParent', 'smokeParentTree', 'scopeBase']) {
    assert.throws(() => assertSourceHistory({ ...actual, [key]: '0'.repeat(40) }))
  }
  for (const key of ['cumulativePaths', 'fixPaths', 'smokePaths']) {
    assert.throws(() => assertSourceHistory({ ...actual, [key]: actual[key].slice(1) }))
    assert.throws(() => assertSourceHistory({ ...actual, [key]: [...actual[key], 'unexpected-product-file.ts'] }))
  }
  assert.throws(() => assertSourceHistory({ ...actual, fixPaths: actual.smokePaths, smokePaths: actual.fixPaths }))
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


test('the user main commit retains all 32 exact blobs independently of the 44-file installer scope', () => {
  const blobs = Object.fromEntries(Object.entries(manifest.preservedMainFiles).map(([path, file]) => [path, file.blob]))
  assert.equal(Object.keys(blobs).length, 32)
  assertPreservedMainFiles(blobs, blobs)
  for (const path of Object.keys(blobs)) {
    assert(!manifest.candidatePaths.includes(path))
    assert(!manifest.files[path])
    const changed = { ...blobs, [path]: '0'.repeat(40) }
    assert.throws(() => assertPreservedMainFiles(changed, blobs))
    assert.throws(() => assertPreservedMainFiles(blobs, changed))
  }
})

test('all five preserved synthetic browser-cookie cases must pass in their own report, never desktop or smoke substitution', () => {
  const path = 'apps/desktop/tests/browser-guests.spec.ts'
  assert.deepEqual(manifest.browserCookieTests, [path])
  assert(manifest.preservedMainFiles[path])
  const specification = manifest.testInventory[path]
  assert.equal(specification.total, 5); assert.equal(specification.requiredTitles.length, 5)
  assert.deepEqual(specification.platformSkips, {})
  const value = { success: true, numFailedTests: 0, numTotalTests: 5, numPassedTests: 5, numPendingTests: 0,
    testResults: [{ name: '/repo/' + path, assertionResults: specification.requiredTitles.map(title => ({ title, status: 'passed' })) }] }
  assert.deepEqual(assertSelectedTestReport(value, 'cookie-test-report', 'linux'), [])
  assert.deepEqual(assertSelectedTestReport(value, 'cookie-test-report', 'win32'), [])
  for (const mode of ['test-report','smoke-test-report','unknown']) assert.throws(() => assertSelectedTestReport(value, mode, 'linux'))
  for (const mutate of [r => { r.numPassedTests-- }, r => { r.testResults[0].assertionResults.pop() },
    r => { r.testResults[0].assertionResults[0].title = 'unrelated case' },
    r => { r.testResults[0].assertionResults[0].status = 'pending'; r.numPassedTests--; r.numPendingTests++ }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => assertSelectedTestReport(changed, 'cookie-test-report', 'linux'))
  }
})


function extensionTap(owner) {
  return ['TAP version 13', ...owner.requiredTitles.map((title, index) => `ok ${index + 1} - ${title}${owner.allowedSkips.some(skip => skip.title === title) ? ' # SKIP' : ''}`),
    `1..${owner.total}`, `# tests ${owner.total}`, '# suites 0', `# pass ${owner.total - owner.allowedSkips.length}`, '# fail 0', '# cancelled 0', `# skipped ${owner.allowedSkips.length}`, '# todo 0', ''].join('\n')
}
test('three isolated extension owners retain 33 real passes and only the declared unconfigured-runtime skip', () => {
  assert.equal(manifest.extensionNodeTests.length, 3)
  assert.deepEqual(manifest.extensionNodeTests.map(owner => owner.total), [7, 15, 12])
  let passed = 0, skipped = 0
  for (const owner of manifest.extensionNodeTests) {
    assert(manifest.preservedMainFiles[owner.path])
    const report = assertExtensionNodeReport(extensionTap(owner), owner.path)
    passed += report.passed; skipped += report.skipped.length
    assert.equal(report.installedHarnessSchemaVerified, false)
    for (const skip of report.skipped) assert.match(skip.reason, /DSH_TEST_RUNTIME is intentionally unset/u)
  }
  assert.equal(passed, 33); assert.equal(skipped, 1)
})
test('extension evidence rejects fabricated counts, missing or changed cases, unknown skips, todos and wrong-owner substitution', () => {
  const owner = manifest.extensionNodeTests[0], text = extensionTap(owner)
  for (const changed of [text.replace('# pass 6', '# pass 7'), text.replace('# tests 7', '# tests 6'),
    text.replace(/^ok 1 .*\n/mu, ''), text.replace(owner.requiredTitles[0], 'unrelated case'),
    text.replace('ok 1 - ', 'not ok 1 - '), text.replace('ok 2 - ' + owner.requiredTitles[1], 'ok 2 - ' + owner.requiredTitles[1] + ' # SKIP'),
    text.replace(' # SKIP', ' # TODO'), text.replace(' # SKIP', ''), text.replace('# fail 0\n', ''),
    text + '# tests 7\n', text.replace('1..7', '1..8')]) assert.throws(() => assertExtensionNodeReport(changed, owner.path))
  assert.throws(() => assertExtensionNodeReport(text, manifest.extensionNodeTests[1].path))
  assert.throws(() => assertExtensionNodeReport(text, '.github/validation/next-desktop.test.mjs'))
})


test('workflow environment and the product checkout independently bind the exact manifest source', () => {
  const workflow = readFileSync(new URL('../../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
  const check = value => {
    const expected = [...value.matchAll(/^  EXPECTED_PRODUCT_SHA: ([a-f0-9]{40})$/gmu)].map(match => match[1])
    const checkout = [...value.matchAll(/^          ref: ([a-f0-9]{40})\n          path: product$/gmu)].map(match => match[1])
    assert.deepEqual(expected, [manifest.source])
    assert.deepEqual(checkout, [manifest.source])
  }
  check(workflow)
  const foreign = '0'.repeat(40)
  for (const changed of [
    workflow.replace('EXPECTED_PRODUCT_SHA: ' + manifest.source, 'EXPECTED_PRODUCT_SHA: ' + foreign),
    workflow.replace('ref: ' + manifest.source + '\n          path: product', 'ref: ' + foreign + '\n          path: product'),
    workflow.replaceAll(manifest.source, foreign),
    workflow.replace('  EXPECTED_PRODUCT_SHA: ' + manifest.source + '\n', ''),
    workflow.replace('          path: product', '          path: unrelated'),
    workflow + '\n  EXPECTED_PRODUCT_SHA: ' + manifest.source + '\n',
  ]) assert.throws(() => check(changed))
})
