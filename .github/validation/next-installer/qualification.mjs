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

/** Keep the installer commits and the four-file documentation commit on one exact linear chain. */
export function assertSourceHistory(actual, m = manifest) {
  assert.equal(actual.installerSource, m.installerSource)
  assert.equal(actual.installerTree, m.installerTree)
  assert.deepEqual(actual.documentationPaths, m.documentationPaths)
  assert.equal(actual.parent, m.parent)
  assert.equal(actual.parentTree, m.parentTree)
  assert.equal(actual.scopeBase, m.scopeBase)
  assert.equal(actual.smokeParent, m.smokeParent)
  assert.equal(actual.smokeParentTree, m.smokeParentTree)
  assert.deepEqual(actual.cumulativePaths, m.candidatePaths)
  assert.deepEqual(actual.fixPaths, m.sourceFixPaths)
  assert.deepEqual(actual.smokePaths, m.smokeFixPaths)
}

/** Keep the separately reviewed test-only fixture revision atop the sealed protocol fix. */
export function assertFixtureRevision(actual, m = manifest) {
  assert.equal(actual.parent, m.fixtureBaseSource)
  assert.deepEqual(actual.paths, m.fixtureFixPaths)
  assert.equal(actual.baseParent, m.baselineSource)
  assert.deepEqual(actual.basePaths, m.protocolFixPaths)
}

/** Preserve the user's 33 disjoint main-branch blobs, independently of the 44-file installer scope. */
export function assertPreservedMainFiles(baseBlobs, currentBlobs, expected = manifest.preservedMainFiles) {
  assert.equal(Object.keys(expected).length, 33)
  const reviewed = Object.fromEntries(Object.entries(expected).map(([path, file]) => [path, file.blob]))
  assert.deepEqual(baseBlobs, reviewed, 'New main baseline differs from the reviewed user commit')
  assert.deepEqual(currentBlobs, reviewed, 'The installer candidate changed a preserved user file')
}

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
  assert(!env.DSH_TEST_RUNTIME, 'A real or ambient Harness runtime is not allowed in synthetic extension tests')
  const gitAt = cwd => (...args) => execFileSync('git', args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  const git = gitAt(root), text = (...args) => git(...args).toString().trim()
  const control = gitAt(resolve(here, '../../..'))
  assert.equal(control('rev-parse', 'HEAD').toString().trim(), env.EXPECTED_CONTROL_SHA)
  assert.equal(control('status', '--porcelain', '--untracked-files=all').toString().trim(), '')
  assert.equal(text('rev-parse', 'HEAD'), m.source)
  assert.equal(text('rev-parse', 'HEAD^{tree}'), m.tree)
  assert.equal(text('status', '--porcelain', '--untracked-files=all'), '', 'source must stay clean')
  if (m.fixtureBaseSource) {
    assertFixtureRevision({ parent: text('rev-parse', 'HEAD^'),
      paths: text('diff', '--name-only', m.fixtureBaseSource, 'HEAD').split('\n').sort(),
      baseParent: text('rev-parse', m.fixtureBaseSource + '^'),
      basePaths: text('diff', '--name-only', m.baselineSource, m.fixtureBaseSource).split('\n').sort() }, m)
  }
  const fixedSource = m.fixtureBaseSource ?? 'HEAD'
  const history = m.baselineSource ?? 'HEAD'
  if (m.baselineSource) {
    assert.equal(text('rev-parse', fixedSource + '^'), m.baselineSource)
    assert.deepEqual(text('diff', '--name-only', m.baselineSource, fixedSource).split('\n').sort(), m.protocolFixPaths)
  }
  assertSourceHistory({ installerSource: text('rev-parse', history + '^'), installerTree: text('rev-parse', history + '^^{tree}'),
    documentationPaths: text('diff', '--name-only', m.installerSource, history).split('\n').sort(),
    parent: text('rev-parse', history + '~2'), parentTree: text('rev-parse', history + '~2^{tree}'),
    scopeBase: text('rev-parse', history + '~4'),
    smokeParent: text('rev-parse', history + '~3'), smokeParentTree: text('rev-parse', history + '~3^{tree}'),
    cumulativePaths: text('diff', '--name-only', m.scopeBase, m.installerSource).split('\n').sort(),
    fixPaths: text('diff', '--name-only', m.parent, m.installerSource).split('\n').sort(),
    smokePaths: text('diff', '--name-only', m.smokeParent, m.parent).split('\n').sort() }, m)
  assertPreservedMainFiles(
    Object.fromEntries(Object.keys(m.preservedMainFiles).map(path => [path, text('rev-parse', `${m.scopeBase}:${path}`)])),
    Object.fromEntries(Object.keys(m.preservedMainFiles).map(path => [path, text('rev-parse', `HEAD:${path}`)])), m.preservedMainFiles)
  for (const [path, expected] of Object.entries({ ...m.files, ...m.preservedMainFiles, ...m.documentationFiles })) {
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

/** Keep the Desktop, smoke-profile and synthetic browser-cookie owners in separate exact reports. */
export function assertSelectedTestReport(report, mode, platform, m = manifest) {
  const files = mode === 'test-report' ? m.desktopTests : mode === 'smoke-test-report' ? m.smokeTests
    : mode === 'cookie-test-report' ? m.browserCookieTests : undefined
  assert(files, 'Unknown reviewed test-report mode')
  return assertTests(report, files, platform, m.testInventory)
}

/** Check one sealed extension owner independently; its installed-runtime skip is never a passing assertion. */
export function assertExtensionNodeReport(output, path, m = manifest) {
  assert.equal(m.extensionNodeTests.length, 3)
  const owner = m.extensionNodeTests.find(item => item.path === path)
  assert(owner, 'Unknown extension Node owner')
  assert.equal(owner.total, owner.requiredTitles.length)
  const lines = output.split(/\r?\n/u)
  assert.equal(lines.filter(line => line === 'TAP version 13').length, 1)
  const plans = lines.filter(line => /^1\.\.\d+$/u.test(line))
  assert.deepEqual(plans, ['1..' + owner.total])
  const cases = lines.map(line => /^(ok|not ok) (\d+) - (.*)$/u.exec(line)).filter(Boolean)
  assert.equal(cases.length, owner.total, 'Missing or unexpected extension assertions')
  const skipped = []
  for (const [index, item] of cases.entries()) {
    assert.equal(item[1], 'ok', 'Extension assertion failed')
    assert.equal(Number(item[2]), index + 1)
    const isSkipped = item[3].endsWith(' # SKIP')
    const title = isSkipped ? item[3].slice(0, -7) : item[3]
    assert.equal(title, owner.requiredTitles[index], 'Extension assertion title/order differs')
    const allowed = owner.allowedSkips.find(entry => entry.title === title)
    assert.equal(isSkipped, Boolean(allowed), 'Unknown skip or unexpectedly enabled installed-runtime test')
    if (isSkipped) skipped.push({ path, ...allowed })
  }
  const passed = cases.length - skipped.length
  for (const [field, count] of Object.entries({ tests: owner.total, suites: 0, pass: passed, fail: 0, cancelled: 0, skipped: skipped.length, todo: 0 })) {
    assert.deepEqual(lines.filter(line => line.startsWith('# ' + field + ' ')), ['# ' + field + ' ' + count], 'Extension TAP counters disagree: ' + field)
  }
  assert(passed > 0)
  return { path, total: cases.length, passed, skipped, installedHarnessSchemaVerified: false,
    scope: 'Synthetic source owner only; no installed Harness, real cookie/profile, or extension installation was tested' }
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
    const uninstall = await command('next-uninstall-regression', process.execPath,
      ['--test', '--test-reporter=tap', 'apps/desktop/tests/next-uninstall-protocol.test.mjs'], 3)
    for (const [counter, count] of Object.entries({ tests: 3, pass: 3, fail: 0, skipped: 0, cancelled: 0 })) {
      assert.match(uninstall.output, new RegExp('# ' + counter + ' ' + count + '\\r?\\n', 'u'))
    }
    await tests('desktop-tests', manifest.desktopTests)
    await tests('smoke-profile-tests', manifest.smokeTests)
    await tests('browser-cookie-tests', manifest.browserCookieTests)
    for (const owner of manifest.extensionNodeTests) {
      const result = await command(owner.label, process.execPath, ['--test', '--test-reporter=tap', owner.path], 1.5)
      const report = assertExtensionNodeReport(result.output, owner.path)
      writeFileSync(join(evidence, owner.label + '.json'), JSON.stringify(report, null, 2) + '\n')
      stages.at(-1).extensionReport = report
    }
    await tests('pointer-unit', manifest.pointerTests)
    // Repository graph emits declarations before aggregate TypeScript programs; TS5 syntax erasure is not a check.
    await command('full-build', 'pnpm', ['run', 'build', '--profile', 'local'], 120)
    await command('doc-links', 'pnpm', ['run', 'verify-md-links'], 5)
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
  else if (mode === 'extension-test-report') {
    const report = assertExtensionNodeReport(readFileSync(rest[0], 'utf8'), rest[1])
    writeFileSync(rest[0] + '.json', JSON.stringify(report, null, 2) + '\n')
  }
  else if (['test-report', 'smoke-test-report', 'cookie-test-report'].includes(mode)) {
    const skipped = assertSelectedTestReport(JSON.parse(readFileSync(rest[0])), mode, process.platform)
    writeFileSync(rest[0] + '.skips.json', JSON.stringify(skipped, null, 2) + '\n')
  } else throw new Error('Unknown qualification mode')
}
