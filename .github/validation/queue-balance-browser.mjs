import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { verify } from './stage2.mjs'
import { runCommand } from './run-command.mjs'
import { assertPassing } from './vitest-evidence.mjs'

export const TARGETS = [
  { label: 'queue-image', file: 'apps/web/tests/queue-image.e2e.ts', suite: 'web e2e: queued image submission', title: 'recalls only the latest queued image after rejection and ignores repeated ArrowUp' },
  { label: 'account-login', file: 'apps/web/tests/account-login.e2e.ts', suite: 'web e2e: DeepSeek account sign-in in a plain browser', title: 'signs in, recovers avatars, and refreshes balance through the Account section' },
]
export const PREREQUISITES = [
  // Pinned build:artifacts owns the mandatory native gate and its Host dependency.
  // Do not compile that same native prerequisite a second time in this narrow lane.
  ['artifacts', ['run', 'build:artifacts'], 90],
  ['aggregate-check', ['run', 'build:check'], 45],
  ['chromium-install', ['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], 15],
]
export const exactFilter = target => '^' + (target.suite + ' ' + target.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
export function assertTarget(result, report, target) {
  assertPassing(result, report, [target.file], [target.title])
  const file = report.testResults[0]
  assert.equal(file.status, 'passed'); assert.equal(file.message ?? '', '')
  const selected = file.assertionResults.filter(x => x.title === target.title)
  assert.equal(selected[0].fullName, target.suite + ' ' + target.title)
  assert.equal(report.numPassedTests, 1)
  assert.equal(report.numTotalTests, file.assertionResults.length)
  assert.equal(report.numTodoTests ?? 0, 0)
  assert.equal(report.numPendingTests ?? 0, file.assertionResults.length - 1)
  return { file: target.file, title: target.title, passed: 1, unselected: file.assertionResults.length - 1 }
}
export function assertEnvironment(env, root) {
  assert.equal(env.DSH_SNAPSHOT, 'replay')
  assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  assert(!existsSync(join(root, '.env')), 'local credentials/config file forbidden')
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) assert(!env[key], 'live credentials forbidden: ' + key)
}
async function main() {
  const root = resolve(process.argv[2])
  const m = JSON.parse(readFileSync(new URL('./queue-balance-browser-manifest.json', import.meta.url)))
  assert.equal(process.version, 'v24.19.0')
  assert.equal(process.env.GITHUB_SHA, process.env.EXPECTED_CONTROL_SHA)
  assert.equal(process.env.EXPECTED_PRODUCT_SHA, m.final)
  assertEnvironment(process.env, root)
  verify(root, m)
  if (process.argv.includes('--identity-only')) return
  const evidence = join(process.env.RUNNER_TEMP, 'dsh-next-evidence')
  mkdirSync(evidence, { recursive: true })
  const results = [], assertions = []
  let failure
  const run = async (label, args, minutes) => {
    // The shared reviewed helper owns the full Linux process group on timeout.
    const r = await runCommand('pnpm', args, { cwd: root, timeout: minutes * 60_000 })
    writeFileSync(join(evidence, label + '.log'), r.output)
    results.push({ label, args, status: r.status, signal: r.signal, error: r.error?.message })
    assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0, label + ' failed')
    verify(root, m)
    return r
  }
  try {
    const version = await run('package-manager-version', ['--version'], 1)
    assert.equal(version.output.trim(), '11.28.5')
    for (const [label, args, minutes] of PREREQUISITES) await run(label, args, minutes)
    for (const target of TARGETS) {
      const output = join(evidence, target.label + '.json')
      const result = await run(target.label, ['exec', 'vitest', 'run', '--config=vitest.web.config.ts', target.file,
        '-t', exactFilter(target), '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + output], 15)
      assertions.push(assertTarget(result, JSON.parse(readFileSync(output)), target))
    }
    assert.equal(assertions.length, 2)
  } catch (error) { failure = error.message; process.exitCode = 1 }
  finally {
    try { verify(root, m) } catch (error) { failure = (failure ?? '') + '\nFinal identity: ' + error.message; process.exitCode = 1 }
    writeFileSync(join(evidence, 'queue-balance-browser-result.json'), JSON.stringify({
      source: m.final, base: m.base, control: process.env.GITHUB_SHA, node: process.version,
      results, assertions, failure, validated: !failure,
      scope: 'Only exact queue-image and account-login browser regressions with shipped Host/Web composition, replay and loopback Platform; not real credentials/balance provider, native desktop, full suite, release or deployment',
    }, null, 2) + '\n')
  }
}
if (import.meta.main) await main()
