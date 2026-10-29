import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run-command.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const manifest = JSON.parse(readFileSync(join(here, 'manifest.json')))
export const nextSourceTestArgs = ['--experimental-transform-types', '--test', '--test-reporter=tap', '.github/validation/next-desktop.test.mjs']
const sha = value => createHash('sha256').update(value).digest('hex')

/** Refuse unsealed controls, foreign repositories, dirty source, and mismatched reviewed bytes. */
export function verifyIdentity(root, m = manifest, env = process.env) {
  root = resolve(root)
  assert.equal(process.version, m.node)
  assert.match(m.source ?? '', /^[a-f0-9]{40}$/u, 'source is not sealed')
  if (m.version !== null) assert.match(m.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(env.GITHUB_REPOSITORY, m.repository)
  assert.equal(env.GITHUB_REPOSITORY_ID, m.repositoryId)
  assert.equal(env.GITHUB_REF, m.controlRef)
  assert.match(env.EXPECTED_CONTROL_SHA ?? '', /^[a-f0-9]{40}$/u)
  assert.equal(env.GITHUB_SHA, env.EXPECTED_CONTROL_SHA)
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.EXPECTED_CONTROL_SHA)
  assert.equal(env.EXPECTED_PRODUCT_SHA, m.source)
  const gitAt = cwd => (...args) => execFileSync('git', args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  const git = gitAt(root), text = (...args) => git(...args).toString().trim()
  const control = gitAt(resolve(here, '../../..'))
  assert.equal(control('rev-parse', 'HEAD').toString().trim(), env.EXPECTED_CONTROL_SHA)
  assert.equal(control('status', '--porcelain', '--untracked-files=all').toString().trim(), '')
  assert.equal(text('rev-parse', 'HEAD'), m.source)
  assert.equal(text('rev-parse', 'HEAD^{tree}'), m.tree)
  assert.equal(text('rev-parse', 'HEAD^'), m.parent)
  assert.equal(text('status', '--porcelain', '--untracked-files=all'), '', 'source must stay clean')
  assert.deepEqual(text('diff', '--name-only', m.parent, m.source).split('\n').sort(), m.candidatePaths)
  for (const [path, expected] of Object.entries(m.files)) {
    assert.equal(text('rev-parse', `HEAD:${path}`), expected.blob, path)
    assert.equal(sha(git('show', `HEAD:${path}`)), expected.sha256, path)
    // Git's declared text filters account for Windows checkout line endings, never arbitrary normalization.
    assert.equal(text('hash-object', '--path=' + path, path), expected.blob, path)
  }
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  assert.equal(env.DSH_SNAPSHOT, 'replay')
  assert(!existsSync(join(root, '.env')))
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    assert(!env[key], 'credential-bearing environment is not accepted: ' + key)
  }
  return m
}

/** Check the full selected test inventory; platform skips are explicit rather than treated as passes. */
export function assertTests(report, expected, platform, inventory = manifest.testInventory) {
  assert.equal(report.success, true)
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0)
  assert.equal(report.unhandledErrors?.length ?? 0, 0)
  assert.equal(report.testResults.length, expected.length)
  const skipped = []
  let actualPassed = 0, actualTotal = 0
  for (const path of expected) {
    const selected = report.testResults.filter(file => file.name.replaceAll('\\', '/').endsWith('/' + path))
    assert.equal(selected.length, 1, path)
    const file = selected[0]
    assert.equal(file.message ?? '', '')
    const specification = inventory[path]
    assert(specification, 'missing reviewed test inventory: ' + path)
    assert.equal(file.assertionResults.length, specification.total, 'missing or unexpected cases: ' + path)
    const allowedSkips = specification.platformSkips[platform] ?? []
    const observedSkips = []
    let filePassed = 0
    for (const item of file.assertionResults) {
      actualTotal++
      assert.equal(item.failureMessages?.length ?? 0, 0)
      if (item.status === 'passed') { actualPassed++; filePassed++; continue }
      assert(allowedSkips.includes(item.title) && ['pending', 'skipped'].includes(item.status), 'unexpected non-pass: ' + path + ': ' + item.title)
      observedSkips.push(item.title)
      skipped.push({ path, title: item.title, reason: 'declared platform-specific source test' })
    }
    assert.deepEqual(observedSkips.sort(), [...allowedSkips].sort(), 'platform skip inventory changed: ' + path)
    assert.equal(filePassed, specification.total - allowedSkips.length, 'owner cases must really pass: ' + path)
    for (const title of specification.requiredTitles) {
      const matches = file.assertionResults.filter(item => item.title === title)
      assert.equal(matches.length, 1, 'required case missing or duplicated: ' + path + ': ' + title)
      if (!allowedSkips.includes(title)) assert.equal(matches[0].status, 'passed')
    }
  }
  assert(actualPassed > 0, 'no real passed assertions')
  assert.equal(report.numTotalTests, actualTotal, 'test total must match actual assertions')
  assert.equal(report.numPassedTests, actualPassed, 'passed count must match actual assertions')
  assert.equal(report.numPendingTests ?? 0, skipped.length, 'skipped count must match actual assertions')
  assert.equal(report.numTodoTests ?? 0, 0)
  return skipped
}

async function linux(root) {
  verifyIdentity(root)
  const evidence = join(process.env.RUNNER_TEMP, 'dsh-next-installer-evidence', 'linux')
  mkdirSync(evidence, { recursive: true })
  const stages = []
  let failure
  async function command(label, executable, args, minutes) {
    const result = await runCommand(executable, args, { cwd: root, timeout: minutes * 60_000,
      env: { ...process.env, NO_COLOR: '1', GITHUB_SHA: manifest.source } })
    writeFileSync(join(evidence, label + '.log'), result.output)
    stages.push({ label, args, status: result.status, signal: result.signal, error: result.error?.message })
    assert.equal(result.error, undefined, label)
    assert.equal(result.signal, null, label)
    assert.equal(result.status, 0, label)
    verifyIdentity(root)
    return result
  }
  async function tests(label, files, browser = false) {
    const path = join(evidence, label + '.json')
    await command(label, 'pnpm', ['exec', 'vitest', 'run', ...(browser ? ['--config=vitest.web.config.ts'] : []),
      ...files, '--maxWorkers=1', '--no-file-parallelism', '--reporter=default', '--reporter=json', '--outputFile=' + path], 20)
    const report = JSON.parse(readFileSync(path))
    const skipped = assertTests(report, files, process.platform)
    if (browser) assert.equal(report.numPassedTests, 2)
    stages.at(-1).skipped = skipped
  }
  try {
    assert.equal((await command('pnpm-version', 'pnpm', ['--version'], 1)).output.trim(), manifest.pnpm)
    const compiler = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json')))
    assert.match(compiler.version, /^6\./u, 'project TypeScript 6 is required')
    const nodeTests = await command('next-source-tests', process.execPath,
      nextSourceTestArgs, 3)
    assert.match(nodeTests.output, /# tests 35\r?\n/u)
    assert.match(nodeTests.output, /# pass 35\r?\n/u)
    assert.match(nodeTests.output, /# (?:skipped|skip) 0\r?\n/u)
    await tests('desktop-tests', manifest.desktopTests)
    await tests('pointer-unit', manifest.pointerTests)
    // Repository graph emits declarations before aggregate TypeScript programs; TS5 syntax erasure is not a check.
    await command('full-build', 'pnpm', ['run', 'build', '--profile', 'local'], 120)
    await command('doc-pairing', 'pnpm', ['run', 'doc-sync'], 30)
    await command('chromium', 'pnpm', ['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], 15)
    await tests('pointer-browser', [manifest.pointerBrowser], true)
  } catch (error) { failure = error.message; process.exitCode = 1 }
  finally {
    try { verifyIdentity(root) } catch (error) { failure = [failure, error.message].filter(Boolean).join('\n'); process.exitCode = 1 }
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ source: manifest.source, tree: manifest.tree,
      control: process.env.EXPECTED_CONTROL_SHA, repositoryId: manifest.repositoryId, stages, failure,
      qualified: !failure, scope: 'Linux project build, selected source tests, documentation pairing and two Chromium regressions; not Windows installation or native GUI' }, null, 2) + '\n')
  }
}

if (import.meta.main) {
  const [mode, root, ...rest] = process.argv.slice(2)
  if (mode === 'identity') verifyIdentity(root)
  else if (mode === 'linux') await linux(resolve(root))
  else if (mode === 'test-report') {
    const skipped = assertTests(JSON.parse(readFileSync(rest[0])), manifest.desktopTests, process.platform)
    writeFileSync(rest[0] + '.skips.json', JSON.stringify(skipped, null, 2) + '\n')
  } else throw new Error('Unknown qualification mode')
}
