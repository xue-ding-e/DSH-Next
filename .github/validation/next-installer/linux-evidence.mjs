import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))

/** Bind a completed Linux qualification to this source, repository, workflow and exact run attempt. */
export function assertLinuxQualification(m, run, jobs, priorManifest, priorBytes, artifacts) {
  const pin = m.linuxQualification
  assert(pin, 'Linux qualification has not been reviewed and pinned')
  assert.equal(run.id, pin.runId)
  assert.equal(run.run_attempt, pin.attempt)
  assert.equal(run.repository.id, Number(m.repositoryId))
  assert.equal(run.repository.full_name, m.repository)
  assert.equal(run.head_sha, pin.control)
  assert.equal(run.head_branch, pin.ref.replace('refs/heads/', ''))
  assert.equal(priorManifest.controlRef, pin.ref)
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.workflow_id, 400043182)
  assert.equal(run.path, '.github/workflows/next-context-menu-validation.yml')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.equal(jobs.total_count, 1)
  assert.equal(jobs.jobs.length, 1)
  assert.equal(jobs.jobs[0].name, 'linux')
  assert.equal(jobs.jobs[0].conclusion, 'success')
  assert.equal(jobs.jobs[0].status, 'completed')
  assert.equal(createHash('sha256').update(priorBytes).digest('hex'), pin.manifestSha256)
  for (const field of ['source', 'tree', 'parent', 'parentTree', 'scopeBase', 'smokeParent', 'smokeParentTree', 'repository', 'repositoryId', 'installerSource', 'installerTree', 'baselineSource', 'fixtureBaseSource']) assert.equal(priorManifest[field], m[field])
  assert.deepEqual(priorManifest.fixtureFixPaths, m.fixtureFixPaths)
  assert.deepEqual(priorManifest.protocolFixPaths, m.protocolFixPaths)
  assert.deepEqual(priorManifest.sourceFixPaths, m.sourceFixPaths)
  assert.deepEqual(priorManifest.smokeFixPaths, m.smokeFixPaths)
  assert.deepEqual(priorManifest.candidatePaths, m.candidatePaths)
  assert.deepEqual(priorManifest.smokeTests, m.smokeTests)
  assert.deepEqual(priorManifest.browserCookieTests, m.browserCookieTests)
  assert.deepEqual(priorManifest.preservedMainFiles, m.preservedMainFiles)
  assert.deepEqual(priorManifest.extensionNodeTests, m.extensionNodeTests)
  assert.deepEqual(priorManifest.documentationPaths, m.documentationPaths)
  assert.deepEqual(priorManifest.documentationFiles, m.documentationFiles)
  assert.deepEqual(priorManifest.files, m.files)
  assert.deepEqual(priorManifest.testInventory, m.testInventory)
  assert.equal(artifacts.total_count, 1)
  assert.equal(artifacts.artifacts.length, 1)
  const artifact = artifacts.artifacts[0]
  assert.equal(artifact.id, pin.artifactId)
  assert.equal(artifact.name, 'next-installer-linux-' + pin.runId)
  assert.equal(artifact.expired, false)
  assert.equal(artifact.digest, 'sha256:' + pin.artifactSha256)
  assert.equal(artifact.workflow_run.id, pin.runId)
  assert.equal(artifact.workflow_run.repository_id, Number(m.repositoryId))
  assert.equal(artifact.workflow_run.head_repository_id, Number(m.repositoryId))
  assert.equal(artifact.workflow_run.head_sha, pin.control)
}

async function main() {
  const m = JSON.parse(readFileSync(join(here, 'manifest.json')))
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(process.env.GITHUB_REPOSITORY, m.repository)
  assert.equal(process.env.GITHUB_REPOSITORY_ID, m.repositoryId)
  assert.equal(process.env.GITHUB_REF, m.controlRef)
  assert.match(process.env.EXPECTED_CONTROL_SHA ?? '', /^[a-f0-9]{40}$/u)
  assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)
  assert.equal(process.env.GITHUB_WORKFLOW_SHA, process.env.EXPECTED_CONTROL_SHA)
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(here, '../../..'), encoding: 'utf8', timeout: 10_000 }).trim(), process.env.EXPECTED_CONTROL_SHA)
  assert.match(m.version ?? '', /^0\.2\.1-rc\.3\.\d{8}\.\d+$/u, 'first actual package version is not reviewed')
  assert.match(m.upgradeVersion ?? '', /^0\.2\.1-rc\.3\.\d{8}\.\d+$/u, 'second actual package version is not reviewed')
  const suffix = version => version.match(/\.(\d{8})\.(\d+)$/u).slice(1).map(Number)
  const [date, index] = suffix(m.version), [nextDate, nextIndex] = suffix(m.upgradeVersion)
  assert([date, index, nextDate, nextIndex].every(Number.isSafeInteger))
  assert(nextDate > date || (nextDate === date && nextIndex > index), 'second package version must be genuinely higher')
  assert(m.linuxQualification, 'Linux result is not sealed')
  const pin = m.linuxQualification
  assert(Number.isSafeInteger(pin.runId) && pin.runId > 0)
  assert(Number.isSafeInteger(pin.attempt) && pin.attempt > 0)
  assert.match(pin.control, /^[a-f0-9]{40}$/u)
  assert.match(pin.manifestSha256, /^[a-f0-9]{64}$/u)
  assert(Number.isSafeInteger(pin.artifactId) && pin.artifactId > 0)
  assert.match(pin.artifactSha256, /^[a-f0-9]{64}$/u)
  const api = 'https://api.github.com/repos/' + m.repository
  async function get(suffix) {
    const response = await fetch(api + suffix, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000) })
    assert(response.ok, 'Read-only public Linux evidence lookup failed: HTTP ' + response.status)
    const body = await response.text()
    assert(body.length < 2 * 1024 * 1024, 'Unexpected evidence response size')
    return JSON.parse(body)
  }
  const run = await get('/actions/runs/' + pin.runId)
  const jobs = await get('/actions/runs/' + pin.runId + '/attempts/' + pin.attempt + '/jobs?per_page=100')
  const previous = await get('/contents/.github/validation/next-installer/manifest.json?ref=' + pin.control)
  const artifacts = await get('/actions/runs/' + pin.runId + '/artifacts?per_page=100')
  assert.equal(previous.type, 'file'); assert.equal(previous.encoding, 'base64')
  const bytes = Buffer.from(previous.content, 'base64')
  assertLinuxQualification(m, run, jobs, JSON.parse(bytes), bytes, artifacts)
  const output = join(process.env.RUNNER_TEMP, 'dsh-next-installer-evidence', 'linux-dependency')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'reviewed-linux.json'), JSON.stringify({ source: m.source, tree: m.tree, priorControl: pin.control,
    runId: pin.runId, attempt: pin.attempt, artifactId: pin.artifactId, artifactSha256: pin.artifactSha256,
    currentControl: process.env.EXPECTED_CONTROL_SHA, linuxQualified: true,
    reviewedContents: pin.reviewedContents,
    scope: 'Completed exact-source Linux prerequisite, not Windows qualification' }, null, 2) + '\n')
}
if (import.meta.main) await main()
