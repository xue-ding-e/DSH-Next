import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { manifest, verifyIdentity } from './qualification.mjs'
import { runCommand } from './run-command.mjs'

export const sampleInstrumentation = `
    await page.addInitScript(() => {
      type Sample = { event: string; at: number; width: number; menus: number; rows: number; open: number; collapse: number }
      const state = window as Window & { __menuDiagnostic?: Sample[]; __menuDiagnosticError?: boolean }
      state.__menuDiagnostic = []
      let previous = ''
      const sample = (event: string): void => {
        try {
        const buttons = [...document.querySelectorAll('button')]
        const item = { event, at: performance.now(), width: window.innerWidth,
          menus: document.querySelectorAll('[role="menu"]').length,
          rows: document.querySelectorAll('[data-row-key]').length,
          open: buttons.filter(button => button.getAttribute('aria-label') === 'Open sidebar').length,
          collapse: buttons.filter(button => button.getAttribute('aria-label') === 'Collapse sidebar').length }
        const signature = JSON.stringify([item.width, item.menus, item.rows, item.open, item.collapse])
        if (event === 'mutation' && signature === previous) return
        previous = signature
        if ((state.__menuDiagnostic?.length ?? 0) < 300) state.__menuDiagnostic?.push(item)
        } catch { state.__menuDiagnosticError = true }
      }
      new MutationObserver(() => sample('mutation')).observe(document, { childList: true, subtree: true, attributes: true })
      window.addEventListener('resize', () => sample('resize'))
      document.addEventListener('contextmenu', () => sample('contextmenu'), true)
    })
`

/** Instrument the synthetic browser fixture without changing any menu assertion or timeout. */
export function instrumentMenuTest(original, synchronize) {
  const replace = (source, before, after) => {
    assert.equal(source.split(before).length, 2, 'Diagnostic patch must match one reviewed site')
    return source.replace(before, after)
  }
  let source = replace(original, "import { readFile } from 'node:fs/promises'", "import { readFile, writeFile } from 'node:fs/promises'")
  source = replace(source, 'import { afterAll, beforeAll, describe, expect, it, onTestFailed }', 'import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed }')
  source = replace(source, '  let workspaceId: string', `  let workspaceId: string
  let diagnosticKind = 'not-started'
  afterEach(async () => {
    // Diagnostics must never replace the original assertion outcome.
    const prefix = process.env.DSH_MENU_DIAGNOSTIC_OUTPUT
    if (prefix === undefined) return
    let observation: object
    try {
      observation = await page.evaluate(() => {
        const state = window as Window & { __menuDiagnostic?: object[]; __menuDiagnosticError?: boolean }
        return { samples: state.__menuDiagnostic ?? [], samplingError: state.__menuDiagnosticError === true }
      })
    } catch { observation = { samples: [], samplingError: true } }
    try { await writeFile(prefix + '-' + diagnosticKind + '.json', JSON.stringify(observation)) }
    catch { /* Diagnostic transport failure must not mask a product assertion. */ }
  })`)
  source = replace(source, "    await page.emulateMedia({ reducedMotion: 'reduce' })", "    await page.emulateMedia({ reducedMotion: 'reduce' })" + sampleInstrumentation)
  source = replace(source, '    onTestFailed(() => saveFailureShot(page, `web-e2e-row-context-menu-${kind}`))', `    onTestFailed(async () => {
      const prefix = process.env.DSH_MENU_DIAGNOSTIC_OUTPUT
      if (prefix === undefined) return
      try { await page.screenshot({ path: prefix + '-' + kind + '.png' }) }
      catch { /* A detached page must not obscure the original failed assertion. */ }
    })
    diagnosticKind = kind
    try {
      await page.evaluate(() => {
        const state = window as Window & { __menuDiagnostic?: object[]; __menuDiagnosticError?: boolean }
        state.__menuDiagnostic = []; state.__menuDiagnosticError = false
      })
    } catch { /* Observation setup is not a replacement test gate. */ }`)
  source = replace(source, "import { newEnglishPage, saveFailureShot } from './support.ts'", "import { newEnglishPage } from './support.ts'")
  if (synchronize) {
    source = replace(source, '    await page.setViewportSize({ width: 1200, height: 720 })',
      `    await page.setViewportSize({ width: 1200, height: 720 })
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).first().waitFor({ state: 'visible' })`)
    source = replace(source, '    if (await reopen.isVisible()) await reopen.click()',
      `    await reopen.waitFor({ state: 'visible' })
    await reopen.click()
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).first().waitFor({ state: 'visible' })`)
  }
  return source
}

/** Restore the reviewed fixture only after the command owner confirms no survivors. */
export async function runInstrumentedRound(file, original, overlay, execute) {
  writeFileSync(file, overlay)
  let quiescent = false
  try {
    const result = await execute()
    quiescent = result.ownership?.cleanupConfirmed === true
      && result.ownership.record?.survivors !== undefined
      && Object.keys(result.ownership.record.survivors).length === 0
    assert(quiescent, 'Diagnostic command ownership is unconfirmed; retain overlay and evidence')
    return result
  } finally {
    if (quiescent) writeFileSync(file, original)
  }
}

export function assertDiagnosticOutcome(result) {
  assert.equal(result.error, undefined, 'Diagnostic owner failed or was cancelled')
  assert.equal(result.signal, null)
  assert([0, 1].includes(result.status), 'Only ordinary Vitest pass/assertion-failure exits permit comparison')
}

async function main() {
  const root = resolve(process.argv[2])
  verifyIdentity(root)
  const evidence = join(process.env.RUNNER_TEMP, 'dsh-next-menu-diagnostic')
  mkdirSync(evidence, { recursive: true })
  const file = join(root, 'apps/web/tests/row-context-menu.e2e.ts')
  const original = readFileSync(file)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const stages = []
  async function command(label, args, minutes, diagnostic = false) {
    const result = await runCommand('pnpm', args, { cwd: root, timeout: minutes * 60000,
      env: { ...process.env, GITHUB_SHA: manifest.source, DSH_MENU_DIAGNOSTIC_OUTPUT: join(evidence, label) } })
    writeFileSync(join(evidence, label + '.log'), result.output)
    stages.push({ label, status: result.status, signal: result.signal, error: result.error?.message,
      cleanupConfirmed: result.ownership.cleanupConfirmed })
    if (!diagnostic) { assert.equal(result.error, undefined); assert.equal(result.status, 0); verifyIdentity(root) }
    return result
  }
  let failure
  try {
    await command('full-build', ['run', 'build', '--profile', 'local'], 120)
    await command('chromium', ['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'playwright', 'install', '--with-deps', 'chromium'], 15)
    for (const [label, synchronize] of [['original-observed', false], ['ready-sidebar-control', true]]) {
      const overlay = instrumentMenuTest(original.toString('utf8'), synchronize)
      const result = await runInstrumentedRound(file, original, overlay, () => command(label, ['exec', 'vitest', 'run', '--config=vitest.web.config.ts',
          'apps/web/tests/row-context-menu.e2e.ts', '--maxWorkers=1', '--no-file-parallelism',
          '--reporter=default', '--reporter=json', '--outputFile=' + join(evidence, label + '-tests.json')], 5, true))
      stages.at(-1).overlaySha256 = digest(overlay)
      stages.at(-1).qualified = false
      verifyIdentity(root)
      assertDiagnosticOutcome(result)
    }
  } catch (error) { failure = error.message; process.exitCode = 1 }
  finally {
    const restored = readFileSync(file).equals(original)
    try { assert(restored, 'Diagnostic overlay remains; ownership or restoration is unconfirmed'); verifyIdentity(root) }
    catch (error) { failure = [failure, error.message].filter(Boolean).join('\n'); process.exitCode = 1 }
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ source: manifest.source, control: process.env.EXPECTED_CONTROL_SHA,
      originalTestSha256: digest(original), stages, failure, restored, qualified: false,
      scope: 'Synthetic instrumented fixture comparison only; not unmodified-source release qualification' }, null, 2) + '\n')
  }
}
if (import.meta.main) await main()
