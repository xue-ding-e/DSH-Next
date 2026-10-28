import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHECKS, classify } from './readonly-freshness.mjs'
const w = readFileSync(new URL('../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
const s = readFileSync(new URL('./readonly-freshness.mjs', import.meta.url), 'utf8')
test('passed, stale and validation failures remain distinct', () => {
  assert.equal(classify({status:0,signal:null}, ''), 'passed')
  assert.equal(classify({status:1,signal:null}, 'gen-doc-graphs: stale graph doc(s): x'), 'stale')
  assert.equal(classify({status:1,signal:null}, 'verify-export-jsdoc: 3 violations'), 'validation-failed')
})
test('timeout signal error unexpected exit and unknown error abort', () => {
  for (const r of [{status:null,signal:'SIGTERM'}, {status:1,signal:null,error:new Error('timeout')}, {status:2,signal:null}]) assert.throws(()=>classify(r, 'stale'))
  for (const text of ['Cannot find package x', 'ERR_MODULE_NOT_FOUND stale', 'TypeError: bad', 'unexplained failure']) assert.throws(()=>classify({status:1,signal:null},text))
})
test('all planned official checks are readonly and exactly enumerated', () => {
  assert.equal(CHECKS.length,13); assert.equal(new Set(CHECKS).size,13)
  for (const c of CHECKS) assert(c.startsWith('verify-'))
  assert(!s.includes("['run', name, '--write']"))
  for (const c of ['verify-doc-graphs','verify-client-catalog','verify-cordis-catalog','verify-cordis-inspect-catalog','verify-persistence-catalog','verify-translation-pairing','verify-persistence-changes']) assert(CHECKS.includes(c))
})
test('diagnostic outcome never means product validated or complete', () => {
  assert(s.includes('productValidated: false')); assert(s.includes('complete: false'))
  assert(s.includes('freshnessPassed: !failure && results.length === CHECKS.length && failed.length === 0'))
  assert(s.includes("return !failure && results.length === CHECKS.length && failed.length === 0 ? 0 : 1"))
})
test('source seals and all schema plus ack hashes checked without changing source', () => {
  assert(s.includes('assert.deepEqual(snapshot(), before'))
  assert(s.includes("git('ls-files', '--others', '--', 'docs')"))
  assert(s.includes('schemaBefore: schema(before)'))
  assert(s.includes('acceptedRecordHashes: ACK'))
})
test('exact two-commit manifest and shallow three-generation checkout', () => {
  const m=JSON.parse(readFileSync(new URL('./stage2-manifest.json',import.meta.url)))
  assert.equal(m.chain.length,2); assert.equal(m.chain[1].parent,m.chain[0].sha)
  assert.equal(m.chain[0].parent,m.base); assert.equal(m.final,m.chain[1].sha)
  assert.equal(m.files.length,124); assert.equal(m.tests.length,35)
  assert(w.includes('fetch-depth: 3')); assert(!w.includes('fetch-depth: 0'))
})
test('workflow clearly diagnostic only and does not generate or run formal validation', () => {
  assert(w.startsWith('name: Next documentation freshness diagnostic-only'))
  assert(w.includes('readonly-freshness.mjs product'))
  assert(w.includes('stage2.mjs product --identity-only'))
  assert(!w.includes('run: node control/.github/validation/stage2.mjs product\n'))
  assert(w.includes('pnpm install --frozen-lockfile --ignore-scripts'))
  assert(!w.includes('--write'))
})
test('read-only permissions serial gate and bounded jobs preserved', () => {
  assert.match(w,/permissions:\n  contents: read\nconcurrency:\n  group: next-reviewed-heavy-validation\n  cancel-in-progress: false/)
  assert(w.includes('node control/.github/validation/heavy-queue.mjs'))
  assert(w.includes('timeout-minutes: 270')); assert(w.includes('timeout-minutes: 300'))
})
test('four exact action pins and credential isolation preserved', () => {
  assert.deepEqual([...new Set([...w.matchAll(/uses: ([^\n]+)/g)].map(x=>x[1]))].sort(), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  ].sort())
  assert.equal([...w.matchAll(/persist-credentials: false/g)].length,2)
  assert(w.includes('include-hidden-files: false'))
})
