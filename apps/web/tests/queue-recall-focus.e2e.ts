/** Queue recall restores the initiating editor through the shipped Web composition. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const ACTIVE = 'Keep this turn running while I revise queued input.'
const OLDER = 'Keep this older queued message'
const LATEST = 'Recall this latest queued message'
const OTHER_DRAFT = 'Another Session keeps this draft'
const SETTLE = { timeout: 15_000 }

/** Read the selection persisted by the shipped Workspace navigator. */
function selectedSession(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dsh.sessions.current')
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && 'sessionId' in value
      && typeof value.sessionId === 'string' ? value.sessionId : undefined
  })
}

describe('web e2e: queue recall focus', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let scratch: string | undefined
  let releaseRecall: (() => void) | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    releaseRecall?.()
    releaseRecall = undefined
    await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => failures.push(error))
    page = undefined
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    scratch = undefined
    if (failures.length > 0) throw new AggregateError(failures, 'queue-recall-focus teardown failed')
  })

  it.skipIf(webSnapshotMode() === 'record').each(['composer', 'control', 'session'] as const)(
    'recalls into its original draft while focus belongs to %s', async (destination) => {
      scratch = await mkdtemp(join(tmpdir(), 'dsh-web-recall-focus-'))
      const ready = join(scratch, 'model-ready')
      const override = join(scratch, 'replay.override.json')
      const entries: ReplayEntry[] = [{ kind: 'hang', readyFile: ready }]
      await writeFile(override, JSON.stringify(entries))
      scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: override, compareReplaySession: false })
      browser = await chromium.launch()
      const activePage = page = await newEnglishPage(browser)
      const tripwire = watchConsole(activePage)
      onTestFailed(() => saveFailureShot(activePage, `web-e2e-queue-recall-focus-${destination}`))
      await activePage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(activePage, scaffold.workspaceCwd)
      const input = activePage.locator('[data-composer-input]').first()
      await writeComposerDraft(activePage, input, ACTIVE)
      await input.press('Enter')
      await expect.poll(() => existsSync(ready), SETTLE).toBe(true)
      const sourceId = await selectedSession(activePage)
      expect(sourceId).toBeDefined()
      for (const text of [OLDER, LATEST]) {
        await writeComposerDraft(activePage, input, text)
        const [admitted] = await Promise.all([
          activePage.waitForResponse('**/api/session/prompt'), input.press('Enter'),
        ])
        expect(admitted.ok()).toBe(true)
      }
      await activePage.getByRole('button', { name: '2 queued messages', exact: true }).waitFor()
      await expect.poll(() => activePage.locator('[data-submission-echo]').count(), SETTLE).toBe(0)
      await input.and(activePage.locator('[contenteditable="true"]')).waitFor()
      expect(await input.textContent()).toBe('')

      let entered = false
      const release = Promise.withResolvers<undefined>()
      releaseRecall = () => { release.resolve(undefined) }
      await activePage.route('**/api/session/updateQueue', async (route) => {
        entered = true
        await release.promise
        await route.continue()
      }, { times: 1 })
      const response = activePage.waitForResponse('**/api/session/updateQueue', { timeout: 0 }).then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await input.click()
      await activePage.keyboard.press('ArrowUp')
      await expect.poll(() => entered, SETTLE).toBe(true)
      await expect.poll(() => input.getAttribute('contenteditable'), SETTLE).toBe('false')

      const commands = activePage.getByRole('button', { name: 'Add files or run commands', exact: true })
      if (destination === 'control') await commands.focus()
      if (destination === 'session') {
        await activePage.getByRole('button', { name: 'New session', exact: true }).last().click()
        await expect.poll(async () => {
          const current = await selectedSession(activePage)
          return current !== undefined && current !== sourceId
        }, SETTLE).toBe(true)
        await writeComposerDraft(activePage, input, OTHER_DRAFT)
        await commands.focus()
      }

      release.resolve(undefined)
      const replied = await response
      if (!replied.ok) throw replied.error
      expect(replied.value.ok()).toBe(true)
      if (destination === 'composer') {
        await expect.poll(() => input.evaluate((surface) => {
          const selection = surface.ownerDocument.getSelection()
          const before = surface.ownerDocument.createRange()
          before.selectNodeContents(surface)
          if (selection?.anchorNode !== null && selection?.anchorNode !== undefined
            && surface.contains(selection.anchorNode)) before.setEnd(selection.anchorNode, selection.anchorOffset)
          else return undefined
          return {
            focused: surface.ownerDocument.activeElement === surface,
            editable: surface.getAttribute('contenteditable'),
            collapsed: selection.isCollapsed,
            before: before.toString(),
          }
        }), SETTLE).toEqual({ focused: true, editable: 'true', collapsed: true, before: LATEST })
        await activePage.keyboard.type(' + edited')
        await expect.poll(() => input.textContent(), SETTLE).toBe(`${LATEST} + edited`)
        const dock = activePage.locator('[data-queue-dock]')
        await expect.poll(() => dock.textContent(), SETTLE).toContain(OLDER)
        expect(await dock.textContent()).not.toContain(LATEST)
      } else {
        await expect.poll(() => input.textContent(), SETTLE).toBe(destination === 'session' ? OTHER_DRAFT : LATEST)
        expect(await commands.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
        if (destination === 'session') {
          const source = activePage.getByRole('region', { name: 'Recent', exact: true })
            .locator(`[data-row-key="recent-session:${sourceId}"]`)
          await source.click()
          await expect.poll(() => selectedSession(activePage), SETTLE).toBe(sourceId)
          await expect.poll(() => input.textContent(), SETTLE).toBe(LATEST)
          const queue = activePage.locator('[data-queue-dock]')
          await expect.poll(() => queue.locator('li', { hasText: OLDER }).count(), SETTLE).toBe(1)
          expect(await queue.locator('li', { hasText: LATEST }).count()).toBe(0)
          expect(await activePage.locator('[data-chat-flow-kind="user"]', { hasText: LATEST }).count()).toBe(0)
          const warningStart = tripwire.warnings.length
          await activePage.reload({ waitUntil: 'load' })
          await expect.poll(() => selectedSession(activePage), SETTLE).toBe(sourceId)
          await expect.poll(() => input.textContent(), SETTLE).toBe(LATEST)
          await expect.poll(() => queue.locator('li', { hasText: OLDER }).count(), SETTLE).toBe(1)
          expect(await queue.locator('li', { hasText: LATEST }).count()).toBe(0)
          expect(await activePage.locator('[data-chat-flow-kind="user"]', { hasText: LATEST }).count()).toBe(0)
          acknowledgeReloadConnectionLoss(tripwire, warningStart)
        }
      }
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    },
  )
})
