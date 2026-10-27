import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STALE_RUN_ID = 39698435848
export const STALE_JOB_ID = 119561459166

/** Accept only the observed stale attempt after proving its complete job/step inventory is terminal. */
export function assertStaleRunIsQuiescent(repo, run, jobs) {
  assert.equal(repo, 'xue-ding-e/XenTerm-Next')
  assert.equal(run.id, STALE_RUN_ID)
  assert.equal(run.status, 'in_progress')
  assert.equal(run.conclusion, null)
  assert.equal(run.run_attempt, 1, 'a new attempt is not the reviewed stale run')
  assert.equal(run.head_sha, '2945e5f54370b10cca6fe0e0253833a719a02054')
  assert.equal(run.updated_at, '2026-10-22T00:14:01Z', 'changed run metadata needs fresh review')
  assert.equal(jobs.total_count, 1, 'every job from filter=all must be accounted for')
  assert.equal(jobs.jobs.length, jobs.total_count, 'the job inventory must be complete')
  const job = jobs.jobs[0]
  assert.equal(job.id, STALE_JOB_ID)
  assert.equal(job.status, 'completed')
  assert.equal(job.conclusion, 'failure')
  assert.equal(job.completed_at, '2026-10-22T00:14:52Z')
  assert.equal(job.steps.length, 11, 'the reviewed complete step inventory must not change')
  assert.deepEqual(job.steps.map(step => step.number), [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17])
  for (const step of job.steps) {
    assert.equal(step.status, 'completed', `stale-run step ${step.number} is still active or unknown`)
    assert.equal(step.conclusion, step.number === 7 ? 'failure' : 'success')
    assert.match(step.completed_at ?? '', /^2026-10-22T00:14:[0-5][0-9]Z$/)
    assert(step.completed_at <= job.completed_at, 'step completion must precede the terminal job time')
  }
}

/** Bind the Flutter predecessor to the reviewed Linux validation, not a stale Mac run. */
export function assertFlutterPredecessor(run, expectedSha) {
  assert.match(expectedSha ?? '', /^[0-9a-f]{40}$/, 'dispatcher must independently supply the reviewed Flutter SHA')
  assert.equal(run.repository.full_name, 'xue-ding-e/XenTerm')
  assert.equal(run.head_sha, expectedSha)
  assert.equal(run.head_branch, 'validation/linux-ui-flows-v2')
  assert.equal(run.path, '.github/workflows/flutter-linux-ui-validation.yml')
  assert.equal(run.event, 'push')
  assert.equal(run.status, 'completed')
  assert.notEqual(run.conclusion, null)
}

/** Preserve the already verified AI validation identity rather than requiring an unrelated new run. */
export function assertAiPredecessor(run) {
  assert.equal(run.id, 40481574537)
  assert.equal(run.repository.full_name, 'xue-ding-e/AI-Toolbox-Next')
  assert.equal(run.head_sha, '0ada44a14ec24485f58fd4f5ff02c776b58d4d42')
  assert.equal(run.head_branch, 'fix/codex-fetched-model-picker-20261027')
  assert.equal(run.path, '.github/workflows/maintenance-validation.yml')
  assert.equal(run.workflow_id, 386744123)
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.run_attempt, 1)
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
}

/** Magpie releases its resource slot only after the queued exact-source full-CI run is terminal. */
export function assertMagpiePredecessor(run, expectedSha) {
  assert.match(expectedSha ?? '', /^[0-9a-f]{40}$/, 'dispatcher must independently supply the reviewed Magpie SHA')
  assert.equal(run.repository.full_name, 'xue-ding-e/Magpie-Next')
  assert.equal(run.head_sha, expectedSha)
  assert.equal(run.head_branch, 'security/compress1187-gzip-contract')
  assert.equal(run.path, '.github/workflows/test.yml')
  assert.equal(run.workflow_id, 393373719)
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.status, 'completed')
  assert.notEqual(run.conclusion, null)
  // A terminal failure releases resources; it is never reported as a passing product validation.
}

/** Permit only the current reviewed validation itself; other DSH activity also blocks heavy work. */
export function isCurrentValidationRun(repo, run, id, sha) {
  return repo === 'xue-ding-e/DSH-Next' && String(run.id) === id
    && run.event === 'workflow_dispatch'
    && run.path === '.github/workflows/next-context-menu-validation.yml'
    && run.head_branch === 'validation/workspace-open-folder' && run.head_sha === sha
}

async function main() {
  const evidenceRoot = join(process.env.RUNNER_TEMP, 'dsh-next-evidence')
  mkdirSync(evidenceRoot, { recursive: true })
  const evidence = { checkedAt: new Date().toISOString(), predecessors: [], staleMetadata: [], success: false }
  const items = [
    ['xue-ding-e/XenTerm', process.env.FLUTTER_VALIDATION_RUN_ID, undefined],
    ['xue-ding-e/AI-Toolbox-Next', '40481574537', 'fix/codex-fetched-model-picker-20261027'],
    ['xue-ding-e/Magpie-Next', process.env.MAGPIE_RUN_ID, 'security/compress1187-gzip-contract'],
  ]
  const request = async path => {
    // Public metadata only: do not pass GITHUB_TOKEN, an OAuth token, or a user secret.
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DSH-Next-validation-queue' },
      signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200, `queue metadata unavailable: ${response.status} ${path}`)
    return response.json()
  }
  try {
    assert.match(process.env.EXPECTED_PRODUCT_SHA ?? '', /^[0-9a-f]{40}$/)
    assert.match(process.env.EXPECTED_CONTROL_SHA ?? '', /^[0-9a-f]{40}$/)
    assert.match(process.env.EXPECTED_AUTOMATION_SHA ?? '', /^[0-9a-f]{40}$/)
    assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_PRODUCT_SHA)
    const main = await request('repos/xue-ding-e/DSH-Next/git/ref/heads/main')
    assert.equal(main.object.sha, process.env.EXPECTED_CONTROL_SHA, 'main must remain at reviewed C until W passes')
    for (const [repo, id, branch] of items) {
      assert.match(id ?? '', /^[1-9][0-9]+$/, `a reviewed predecessor run ID is required for ${repo}`)
      const run = await request(`repos/${repo}/actions/runs/${id}`)
      assert.equal(String(run.id), id, 'predecessor response must match the independently supplied run ID')
      assert.equal(run.repository.full_name, repo)
      assert.equal(run.status, 'completed', `${repo} run ${id} has not reached a terminal state`)
      assert.notEqual(run.conclusion, null)
      if (branch) assert.equal(run.head_branch, branch)
      if (repo === 'xue-ding-e/XenTerm') assertFlutterPredecessor(run, process.env.FLUTTER_EXPECTED_SHA)
      if (repo === 'xue-ding-e/AI-Toolbox-Next') assertAiPredecessor(run)
      if (repo === 'xue-ding-e/Magpie-Next') assertMagpiePredecessor(run, process.env.MAGPIE_EXPECTED_SHA)
      evidence.predecessors.push({ repo, id, status: run.status, conclusion: run.conclusion, headSha: run.head_sha })
      console.log(`Queue predecessor: ${repo} ${id} ${run.status}/${run.conclusion} ${run.head_sha}`)
    }
    // This is a fail-closed preflight, not a cross-repository mutex. The dispatcher
    // must retain the agreed queue order and avoid launching competing heavy jobs.
    for (const repo of ['xue-ding-e/XenTerm', 'xue-ding-e/XenTerm-Next', 'xue-ding-e/AI-Toolbox-Next', 'xue-ding-e/Magpie-Next', 'xue-ding-e/DSH-Next']) {
      for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
        const runs = await request(`repos/${repo}/actions/runs?status=${status}&per_page=100`)
        assert.equal(runs.workflow_runs.length, runs.total_count, 'incomplete active-run inventory requires manual review')
        for (const queued of runs.workflow_runs) {
          if (isCurrentValidationRun(repo, queued, process.env.GITHUB_RUN_ID, process.env.EXPECTED_PRODUCT_SHA)) continue
          assert(repo === 'xue-ding-e/XenTerm-Next' && queued.id === STALE_RUN_ID && status === 'in_progress',
            `${repo} run ${queued.id} is still ${status}; do not start DSH`)
          const run = await request(`repos/${repo}/actions/runs/${STALE_RUN_ID}`)
          const jobs = await request(`repos/${repo}/actions/runs/${STALE_RUN_ID}/jobs?filter=all&per_page=100`)
          const observed = {
            repo, id: run.id, status: run.status, conclusion: run.conclusion, attempt: run.run_attempt,
            updatedAt: run.updated_at, headSha: run.head_sha, totalJobs: jobs.total_count, allowed: false,
            jobs: jobs.jobs.map(job => ({ id: job.id, status: job.status, conclusion: job.conclusion,
              completedAt: job.completed_at, steps: job.steps.map(step => ({ number: step.number,
                status: step.status, conclusion: step.conclusion, completedAt: step.completed_at })) })),
          }
          evidence.staleMetadata.push(observed)
          assertStaleRunIsQuiescent(repo, run, jobs)
          observed.allowed = true
          console.log(`Known metadata anomaly ${STALE_RUN_ID}: its only job ${STALE_JOB_ID} and all 11 steps are terminal; no cancellation requested.`)
        }
      }
    }
    evidence.success = true
    console.log('Preflight complete: reviewed predecessors are terminal; no active work beyond the verified exact metadata anomaly.')
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    writeFileSync(join(evidenceRoot, 'queue.json'), JSON.stringify(evidence, null, 2) + '\n')
  }
}

if (import.meta.main) await main()
