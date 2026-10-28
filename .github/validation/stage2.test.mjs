import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertPinned, assertReport } from './stage2.mjs'
import { isCurrentValidationRun, assertCcPredecessor } from './heavy-queue.mjs'
const m = JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url)))
const sha = 'a'.repeat(40)
const fixture = () => ({ final: sha, tree: 'd'.repeat(40), base: 'b'.repeat(40), chain: [{ sha, parent: 'b'.repeat(40) }], files: [{ path: 'x.ts', mode: '100644', blob: 'c'.repeat(40) }] })
const report = () => ({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [{ name: '/root/a.spec.ts', status: 'passed', assertionResults: [{ status: 'passed', fullName: 'works' }] }] })
test('unreviewed template cannot run', () => assert.throws(() => assertPinned({ ...fixture(), final: 'UNPINNED_FINAL_GENERATED_SHA' })))
test('pin requires final chain identity, exact blob and normal path', () => {
  assertPinned(fixture())
  for (const mutate of [m => m.chain[0].sha = 'b'.repeat(40), m => m.files[0].blob = 'unreviewed', m => m.files[0].path = '../escape', m => m.files.push(m.files[0])]) {
    const m = fixture(); mutate(m); assert.throws(() => assertPinned(m))
  }
})
test('exact nonempty report accepted', () => assert.equal(assertReport(report(), ['a.spec.ts']), 1))
test('missing/duplicate file, skipped assertion, empty suite and process errors rejected', () => {
  for (const mutate of [r => r.testResults = [], r => r.testResults.push(r.testResults[0]), r => r.testResults[0].assertionResults = [], r => r.testResults[0].assertionResults[0].status = 'pending', r => r.unhandledErrors = ['error'], r => r.numRuntimeErrorTestSuites = 1, r => r.numTotalTests = 2, r => r.testResults[0].message = 'load error']) {
    const r = report(); mutate(r); assert.throws(() => assertReport(r, ['a.spec.ts']))
  }
})
test('only exact current control job can pass queue self-exemption', () => {
 const r = { id: 1, event: 'workflow_dispatch', path: '.github/workflows/next-context-menu-validation.yml', head_branch: 'validation/queue-recall-locked-validation-20261027', head_sha: sha }
 assert(isCurrentValidationRun('xue-ding-e/DSH-Next',r,'1',sha))
 assert(!isCurrentValidationRun('xue-ding-e/DSH-Next',{...r,head_branch:'validation/queue-recall-generation-20261027'},'1',sha))
})

test('final manifest binds one reviewed logical queue commit and all 35 real file paths', () => {
 assertPinned(m)
 assert.equal(m.final, '07b53ef00927b4f053ddd1ddd19207297876822d')
 assert.equal(m.base, '282f8d630784eab0d935ca06155d96f773983b1e')
 assert.equal(m.chain.length, 1)
 assert.equal(m.files.length, 80)
 const helper = 'packages/api/session-controller/tests/queue-recall-agent.ts'
 assert(m.files.some(file => file.path === helper))
 assert(!m.tests.includes(helper))
 assert.deepEqual(m.tests.slice(0, 34), [
  "packages/api/session-controller/tests/queue-recall-projection.host.spec.ts",
  "packages/api/session-controller/tests/queue-recall-replay.host.spec.ts",
  "packages/api/session-controller/tests/queue-recall-transaction.host.spec.ts",
  "packages/api/session-controller/tests/queue-recall-jsonl.host.spec.ts",
  "packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts",
  "packages/api/session-controller/tests/control-queue.host.spec.ts",
  "packages/api/session-controller/tests/controller.host.spec.ts",
  "packages/api/session-controller/tests/projection-discovery.host.spec.ts",
  "packages/client/file-upload/tests/queue-recall-files.host.spec.ts",
  "packages/client/file-upload/tests/queued-file-route.host.spec.ts",
  "packages/client/file-upload/tests/file-upload-http.host.spec.ts",
  "packages/client/file-upload/tests/queued-file.client.spec.ts",
  "packages/client/file-upload/tests/file-upload.client.spec.ts",
  "packages/client/ui-conversation/tests/queue-recall-recovery.client.spec.ts",
  "packages/client/ui-conversation/tests/keymap-routing.client.spec.tsx",
  "packages/client/ui-conversation/tests/service-orchestration.client.spec.ts",
  "packages/client/ui-conversation/tests/queue-dock.client.spec.tsx",
  "packages/core/agent-loop/tests/inbox.spec.ts",
  "packages/core/agent-loop/tests/resume.spec.ts",
  "packages/session/session-persistence-jsonl/tests/jsonl.spec.ts",
  "packages/session/session-persistence-jsonl/tests/generation.spec.ts",
  "packages/session/session-persistence-jsonl/tests/fork-delivery.spec.ts",
  "packages/client/ui-workspace/tests/rows.client.spec.tsx",
  "packages/client/ui-workspace/tests/open-workspace-folder.client.spec.ts",
  "packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx",
  "packages/client/ui-workspace/tests/apply.client.spec.ts",
  "packages/client/ui-workspace/tests/access-assembly.client.spec.tsx",
  "packages/client/ui-settings-account/tests/account-refresh.client.spec.ts",
  "packages/client/ui-settings-account/tests/account.client.spec.tsx",
  "packages/client/ui-primitives/tests/menu-anchor-width.client.spec.tsx",
  "packages/client/ui-primitives/tests/menu-group.client.spec.tsx",
  "packages/client/ui-primitives/tests/menu-surface.client.spec.tsx",
  "packages/client/ui-primitives/tests/menu-top-clearance.client.spec.tsx",
  "scripts/locale-dictionary-parity.spec.ts"
])
 assert.equal(m.tests[33], 'scripts/locale-dictionary-parity.spec.ts')
 assert.equal(m.tests[34], 'packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts')
 assert.equal(m.tests.filter(path => path.startsWith('packages/')).length, 34)
 assert.equal(m.tests.length, 35)
 assert.equal(new Set(m.tests).size, 35)
 assert(m.tests.includes('packages/api/session-controller/tests/queue-recall-jsonl.host.spec.ts'))
})
test('CC predecessor fails closed on active, unknown and altered identity', () => {
 const r = { id: 40602600351, repository: { full_name: 'xue-ding-e/CC-Switch-Next' }, head_sha: 'b5e6702a6be29f3413a689f94d718bca4df8e782', head_branch: 'main', path: '.github/workflows/cloud-validation.yml', workflow_id: 386700965, event: 'push', run_attempt: 1, status: 'completed', conclusion: 'success' }
 assertCcPredecessor(r)
 assertCcPredecessor({...r, conclusion:'failure'})
 for (const change of [{status:'in_progress'}, {conclusion:null}, {conclusion:'unknown'}, {id:1}, {head_sha:sha}, {head_branch:'other'}, {path:'other'}, {workflow_id:1}, {event:'workflow_dispatch'}, {run_attempt:2}]) assert.throws(() => assertCcPredecessor({...r,...change}))
})
test('manifest rejects disconnected ancestry even with final identity preserved', () => {
 const broken=fixture(); broken.chain[0].parent=sha; assert.throws(()=>assertPinned(broken))
})
test('workflow retains bounded shallow exact checkout, four action pins and read-only permission', () => {
 const workflow=readFileSync(new URL('../workflows/next-context-menu-validation.yml',import.meta.url),'utf8')
 const controlCheckout=workflow.split('      - name: Checkout immutable validation controls\n')[1]?.split('      - name: ')[0]
 assert(controlCheckout, 'the control checkout step must exist')
 assert.match(controlCheckout, /sparse-checkout: \|\n            \.github\/validation\n            \.github\/workflows\n/, 'control sparse checkout must include its validation code and inspected workflow')
 assert(workflow.includes('fetch-depth: 2'))
 assert(!workflow.includes('fetch-depth: 0'))
 assert(!workflow.includes('UNPINNED'))
 assert(workflow.includes('contents: read'))
 assert(workflow.includes('timeout-minutes: 300'))
 assert.equal(new Set([...workflow.matchAll(/uses: ([^\n]+)/g)].map(x=>x[1])).size,4)
 const guard=readFileSync(new URL('./heavy-queue.mjs',import.meta.url),'utf8')
 assert(guard.includes("for (const repo of ['xue-ding-e/CC-Switch-Next'"))
 const browser=readFileSync(new URL('./context-menu-browser.mjs',import.meta.url),'utf8')
 assert(browser.includes('verify(root, manifest)'))
 assert(!browser.includes('verifyProductGraph'))
})
