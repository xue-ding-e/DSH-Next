import assert from 'node:assert/strict'

export const ROWS = 'packages/client/ui-workspace/src/client/rows/Rows.tsx'
export const ROW_TEST = 'packages/client/ui-workspace/tests/rows.client.spec.tsx'
export const BASE = 'fae57ca3e87f40b0fdb0500334d5519a212ae1c2'
export const WORKSPACE_REGRESSION = 'workspace right-click and keyboard menu open the clicked folder without toggling'
export const BROWSER_WORKSPACE_TEST = 'DSH-Next workspace menu opens only the clicked Host folder'
export const REGRESSION = 'right-click opens the target row menu without selecting it'
export const BROWSER_FILE = 'apps/web/tests/client-plugin-live.e2e.ts'
export const BROWSER_TEST = 'DSH-Next right-click reuses session actions without opening the target'
export const UNIT_FILES = [
  ROW_TEST,
  ...['open-workspace-folder.client.spec.ts', 'workspace-browser.client.spec.tsx', 'apply.client.spec.ts', 'access-assembly.client.spec.tsx'].map(name => `packages/client/ui-workspace/tests/${name}`),
  ...['anchor-width', 'group', 'surface', 'top-clearance'].map(name =>
    `packages/client/ui-primitives/tests/menu-${name}.client.spec.tsx`),
]

function files(report, expected) {
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, 'runtime errors are not regression evidence')
  assert.equal(report.unhandledErrors?.length ?? 0, 0, 'unhandled errors are not regression evidence')
  assert(Array.isArray(report.testResults), 'missing testResults')
  assert.equal(report.testResults.length, expected.length, 'unexpected test file inventory')
  for (const suffix of expected) {
    const matching = report.testResults.filter(file => file.name.replaceAll('\\', '/').endsWith('/' + suffix))
    assert.equal(matching.length, 1, `expected exactly one result for ${suffix}`)
    assert(matching[0].assertionResults.length > 0, 'an empty suite cannot pass')
  }
  return report.testResults.flatMap(file => file.assertionResults)
}

/** Reject process, loading, timeout, and unrelated failures instead of calling them a reproduction. */
export function assertNegativeControl(result, report) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 1, 'negative control must exit with assertion failure')
  assert.equal(report.success, false)
  const assertions = files(report, [ROW_TEST])
  const selected = assertions.filter(test => test.title.startsWith(REGRESSION))
  assert.deepEqual(selected.map(test => test.title).sort(), [false, true].map(value =>
    `${REGRESSION} (archived=${value})`).sort())
  assert.equal(report.numFailedTests, 2)
  assert.equal(report.testResults[0].message ?? '', '', 'a file-level error is not the intended test failure')
  assert.doesNotMatch(result.output ?? '', /Unhandled (?:Errors?|Rejections?|Exceptions?)|unhandledRejection|ERR_UNHANDLED_REJECTION/i)
  assert.equal(report.numPassedTests, 0)
  assert.equal(assertions.filter(test => test.status === 'failed').length, 2)
  for (const test of selected) {
    assert.equal(test.status, 'failed')
    assert.equal(test.failureMessages.length, 1, 'a second error must not hide behind the expected assertion')
    const detail = test.failureMessages.join('\n').replace(/\u001b\[[0-9;]*m/g, '')
    assert.match(detail, /AssertionError: expected true to be false/)
    assert.match(detail, /rows\.client\.spec\.tsx:1079:\d+/)
    assert.doesNotMatch(detail, /timed?\s*out|Cannot find|Failed to resolve|SyntaxError|ReferenceError/i)
  }
  // Other cases are deliberately unselected by -t; they must never execute or fail here.
  for (const test of assertions.filter(test => !test.title.startsWith(REGRESSION))) {
    assert(['pending', 'skipped', 'todo', 'disabled'].includes(test.status))
  }
}

/** The new Workspace case must fail specifically at native context-menu prevention on its unpatched row. */
export function assertWorkspaceNegativeControl(result, report) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.equal(report.success, false)
  assert.equal(report.numFailedTests, 1)
  assert.equal(report.numPassedTests, 0)
  const assertions = files(report, [ROW_TEST])
  const selected = assertions.filter(test => test.title === WORKSPACE_REGRESSION)
  assert.equal(selected.length, 1)
  assert.equal(report.testResults[0].message ?? '', '')
  assert.doesNotMatch(result.output ?? '', /Unhandled (?:Errors?|Rejections?|Exceptions?)|unhandledRejection|ERR_UNHANDLED_REJECTION/i)
  const test = selected[0]
  assert.equal(test.status, 'failed')
  assert.equal(test.failureMessages.length, 1)
  const detail = test.failureMessages[0].replace(/\u001b\[[0-9;]*m/g, '')
  assert.match(detail, /AssertionError: expected false to be true/)
  assert.match(detail, /rows\.client\.spec\.tsx:704:\d+/)
  assert.doesNotMatch(detail, /timed?\s*out|Cannot find|Failed to resolve|SyntaxError|ReferenceError/i)
  for (const test of assertions.filter(test => test.title !== WORKSPACE_REGRESSION)) {
    assert(['pending', 'skipped', 'todo', 'disabled'].includes(test.status))
  }
}

/** Every selected file must execute real passing tests, with no pending/todo substitutes. */
export function assertPassing(result, report, expectedFiles, requiredTitles = []) {
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0)
  assert.equal(report.success, true)
  assert.equal(report.numFailedTests, 0)
  const assertions = files(report, expectedFiles)
  const selected = requiredTitles.length
    ? assertions.filter(test => requiredTitles.includes(test.title))
    : assertions
  assert(selected.length > 0)
  for (const title of requiredTitles) assert.equal(selected.filter(test => test.title === title).length, 1)
  for (const test of selected) {
    assert.equal(test.status, 'passed', `${test.title} did not execute successfully`)
    assert.equal(test.failureMessages?.length ?? 0, 0)
  }
  if (requiredTitles.length) {
    for (const test of assertions.filter(test => !requiredTitles.includes(test.title))) {
      assert(['pending', 'skipped', 'todo', 'disabled'].includes(test.status))
    }
    assert.equal(report.numPassedTests, requiredTitles.length)
  } else {
    assert.equal(report.numPassedTests, assertions.length)
    assert.equal(report.numPendingTests ?? 0, 0)
    assert.equal(report.numTodoTests ?? 0, 0)
  }
}
