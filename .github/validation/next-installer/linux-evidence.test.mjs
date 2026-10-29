import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { assertLinuxQualification } from './linux-evidence.mjs'

function fixture() {
  const prior = { source: 'a'.repeat(40), tree: 'b'.repeat(40), parent: 'c'.repeat(40), parentTree: 'f'.repeat(40), scopeBase: '0'.repeat(40),
    installerSource: '5'.repeat(40), installerTree: '6'.repeat(40), documentationPaths: ['README.md'], documentationFiles: { 'README.md': { sha256: '7'.repeat(64) } },
    smokeParent: '1'.repeat(40), smokeParentTree: '2'.repeat(40), smokeFixPaths: ['smoke.ts', 'smoke.spec.ts'],
    sourceFixPaths: ['paths.spec.ts', 'main.spec.ts'], candidatePaths: ['base.ts', 'smoke.ts', 'smoke.spec.ts'], smokeTests: ['smoke.spec.ts'], browserCookieTests: ['browser.spec.ts'], extensionNodeTests: [{ path: 'extension.test.mjs', total: 7, allowedSkips: ['explicit runtime'] }], preservedMainFiles: { browser: 'locked baseline blob' }, repository: 'xue-ding-e/DSH-Next',
    repositoryId: '1437727533', controlRef: 'refs/heads/validation/reviewed-linux', files: { source: 'locked hash' }, testInventory: { tests: 'locked cases' } }
  const bytes = Buffer.from(JSON.stringify(prior))
  const m = { ...prior, controlRef: 'refs/heads/validation/windows', linuxQualification: { runId: 123, attempt: 1, control: 'd'.repeat(40),
    ref: prior.controlRef, manifestSha256: createHash('sha256').update(bytes).digest('hex'), artifactId: 456, artifactSha256: 'e'.repeat(64) } }
  const run = { id: 123, run_attempt: 1, repository: { id: 1437727533, full_name: m.repository },
    head_sha: m.linuxQualification.control, head_branch: 'validation/reviewed-linux', event: 'workflow_dispatch',
    workflow_id: 400043182, path: '.github/workflows/next-context-menu-validation.yml', status: 'completed', conclusion: 'success' }
  const jobs = { total_count: 1, jobs: [{ name: 'linux', status: 'completed', conclusion: 'success' }] }
  const artifacts = { total_count: 1, artifacts: [{ id: 456, name: 'next-installer-linux-123', expired: false,
    digest: 'sha256:' + m.linuxQualification.artifactSha256, workflow_run: { id: 123, repository_id: 1437727533,
      head_repository_id: 1437727533, head_sha: run.head_sha } }] }
  return { m, run, jobs, prior, bytes, artifacts }
}
test('only the exact completed successful Linux source/control/run attempt satisfies Windows dependency', () => {
  const { m, run, jobs, prior, bytes, artifacts } = fixture()
  assertLinuxQualification(m, run, jobs, prior, bytes, artifacts)
})
test('foreign, pending, failed, rerun, changed-source, missing-job and forged-manifest evidence fails closed', () => {
  for (const mutate of [
    f => { f.run.repository.id-- }, f => { f.run.head_sha = '0'.repeat(40) }, f => { f.run.run_attempt++ },
    f => { f.run.status = 'in_progress' }, f => { f.run.conclusion = 'failure' }, f => { f.run.event = 'push' },
    f => { f.jobs.jobs = [] }, f => { f.jobs.jobs[0].conclusion = 'skipped' }, f => { f.jobs.total_count++ },
    f => { f.prior.source = '0'.repeat(40) }, f => { f.prior.controlRef = 'refs/heads/foreign' },
    f => { f.prior.testInventory = {} }, f => { f.bytes = Buffer.from('forged') }, f => { f.m.linuxQualification = null },
    f => { f.artifacts.artifacts[0].digest = 'sha256:' + '0'.repeat(64) },
    f => { f.artifacts.artifacts[0].expired = true }, f => { f.artifacts.artifacts[0].workflow_run.head_sha = '0'.repeat(40) },
    f => { f.artifacts.artifacts[0].id++ }, f => { f.artifacts.artifacts = [] },
    f => { f.prior.parentTree = '0'.repeat(40) }, f => { f.prior.scopeBase = 'a'.repeat(40) },
    f => { f.prior.smokeParent = '3'.repeat(40) }, f => { f.prior.smokeParentTree = '4'.repeat(40) },
    f => { f.prior.installerSource = '0'.repeat(40) }, f => { f.prior.installerTree = '0'.repeat(40) },
    f => { f.prior.documentationPaths = [] }, f => { f.prior.documentationFiles = {} },
    f => { f.prior.smokeFixPaths = [] }, f => { f.prior.sourceFixPaths = [] }, f => { f.prior.candidatePaths = [] }, f => { f.prior.smokeTests = [] },
    f => { f.prior.browserCookieTests = [] }, f => { f.prior.preservedMainFiles = {} }, f => { f.prior.extensionNodeTests = [] },
  ]) {
    const f = fixture(); mutate(f)
    assert.throws(() => assertLinuxQualification(f.m, f.run, f.jobs, f.prior, f.bytes, f.artifacts))
  }
})
