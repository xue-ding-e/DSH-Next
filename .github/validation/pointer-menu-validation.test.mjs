import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertRed, rowTitles } from './pointer-menu-validation.mjs'
const file = 'packages/client/ui-workspace/tests/rows.client.spec.tsx'
const result = { status: 1, signal: null, output: '' }
const make = () => ({ success: false, numFailedTests: 2, numPassedTests: 0, testResults: [{ name: '/synthetic/' + file, message: '', assertionResults: rowTitles.map(title => ({ title, status: 'failed', failureMessages: ["AssertionError: expected '250px' to be '100px'\n at rows.client.spec.tsx:1711:48"] })) }] })
test('synthetic gate accepts only expected assertion failures', () => assertRed(result, make(), file, rowTitles, /expected '250px' to be '100px'/, /rows\.client\.spec\.tsx:1711:\d+/))
for (const [name, change] of [
  ['empty suite', r => { r.testResults[0].assertionResults = [] }],
  ['skipped regression', r => { r.testResults[0].assertionResults[0].status = 'skipped' }],
  ['compile error', r => { r.testResults[0].message = 'compile failed' }],
  ['runtime error', r => { r.numRuntimeErrorTestSuites = 1 }],
  ['wrong assertion', r => { r.testResults[0].assertionResults[0].failureMessages = ['AssertionError: unrelated'] }],
  ['same message at wrong assertion', r => { r.testResults[0].assertionResults[0].failureMessages[0] = r.testResults[0].assertionResults[0].failureMessages[0].replace(':1711:', ':1720:') }],
  ['hook failure', r => { r.testResults[0].assertionResults[0].failureMessages[0] += '\n afterEach hook failed' }],
  ['mixed load error', r => { r.testResults[0].assertionResults[0].failureMessages.push('Cannot find module') }],
]) test('synthetic gate rejects ' + name, () => { const r = make(); change(r); assert.throws(() => assertRed(result, r, file, rowTitles, /expected '250px' to be '100px'/, /rows\.client\.spec\.tsx:1711:\d+/)) })
test('synthetic gate rejects timeout and unhandled errors', () => {
  assert.throws(() => assertRed({ ...result, error: new Error('timeout') }, make(), file, rowTitles, /expected/, /rows\.client\.spec\.tsx:1711:\d+/))
  assert.throws(() => assertRed({ ...result, output: 'Unhandled Rejection' }, make(), file, rowTitles, /expected/, /rows\.client\.spec\.tsx:1711:\d+/))
})
