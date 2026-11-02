import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE, PRODUCT, PREVIOUS_CONTROL, PREVIOUS_BLOBS, DECLARATION, BLOB, CONTROLS, checkIdentity, checkMemory, checkTests } from './build-version-guard.mjs'
const good = () => ({ repo: 'xue-ding-e/DSH-Next', event: 'workflow_dispatch', ref: 'refs/heads/validation/desktop-build-version-channel',
  expectedControl: 'a'.repeat(40), expectedProduct: PRODUCT, eventSha: 'a'.repeat(40), control: 'a'.repeat(40), product: PRODUCT,
  controlParents: [PREVIOUS_CONTROL], previousControlParents: [PRODUCT], previousControlFiles: [...CONTROLS], previousControlBlobs: [...PREVIOUS_BLOBS], productToControlFiles: [...CONTROLS], productParents: [BASE], productFiles: [DECLARATION], controlFiles: [...CONTROLS], blob: BLOB,
  productStatus: '', controlStatus: '' })
test('accept exact reviewed linear graph', () => checkIdentity(good()))
for (const [field, value] of Object.entries({ repo: 'other/repo', event: 'pull_request', ref: 'refs/heads/main', expectedControl: 'main',
  eventSha: 'c'.repeat(40), product: 'c'.repeat(40), controlParents: ['b'.repeat(40), 'c'.repeat(40)], productParents: ['c'.repeat(40)],
  productFiles: [DECLARATION, 'package.json'], controlFiles: [...CONTROLS, '.github/workflows/next-release.yml'], blob: 'c'.repeat(40),
  productStatus: ' M package.json', controlStatus: '?? extra' })) {
  test(`reject changed ${field}`, () => assert.throws(() => checkIdentity({ ...good(), [field]: value })))
}
test('16GiB physical with unbounded cgroup passes', () => assert.equal(checkMemory(16*1024**3, ['max']), 16*1024**3))
test('12GiB effective boundary passes', () => assert.equal(checkMemory(16*1024**3, [String(12*1024**3)]), 12*1024**3))
test('7GiB cgroup on 16GiB physical rejected', () => assert.throws(() => checkMemory(16*1024**3, [String(7*1024**3)])))
test('ancestor limit enforced', () => assert.throws(() => checkMemory(16*1024**3, ['max', String(7*1024**3)])))
test('unknown limit rejected', () => assert.throws(() => checkMemory(16*1024**3, ['unknown'])))
const report = () => ({success:true,numTotalTests:25,numPassedTests:25,numFailedTests:0,numPendingTests:0,numTodoTests:0,
  testResults:[{name:'/product/apps/desktop/tests/desktop-build-version.spec.ts',assertionResults:Array.from({length:25},()=>({status:'passed'}))}]})
test('25 genuine tests accepted', () => checkTests(report()))
for (const [field,value] of Object.entries({success:false,numTotalTests:24,numPassedTests:24,numFailedTests:1,numPendingTests:1,numTodoTests:1}))
  test(`reject report ${field}`, () => assert.throws(() => checkTests({...report(),[field]:value})))
test('wrong file rejected', () => { const r=report();r.testResults[0].name='/other.spec.ts';assert.throws(()=>checkTests(r)) })
test('individual skip rejected', () => { const r=report();r.testResults[0].assertionResults[0].status='pending';assert.throws(()=>checkTests(r)) })

const push = () => ({...good(), event:'push', before:PREVIOUS_CONTROL, after:'a'.repeat(40), created:false, deleted:false, forced:false})
test('accept exact first reviewed push', () => checkIdentity(push()))
for (const [field,value] of Object.entries({before:'c'.repeat(40),after:'c'.repeat(40),created:true,deleted:true,forced:true,previousControlParents:['c'.repeat(40)],previousControlBlobs:[],previousControlFiles:[],productToControlFiles:[...CONTROLS,'package.json']}))
  test(`reject push ${field}`, () => assert.throws(()=>checkIdentity({...push(),[field]:value})))
