/** Pointer and keyboard row menus in the shipped Web composition; no model calls. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const TARGET = 'row-context-menu-target'
const SELECTED = 'row-context-menu-selected'

describe('web e2e: row context-menu placement', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let workspaceId: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    workspaceId = workspace.id
    const fixture = await readFile(SEED, 'utf8')
    for (const id of [TARGET, SELECTED]) {
      const sessionId = await seedSession(scaffold, fixture, id)
      await workspace.attachSession(sessionId)
      await scaffold.ctx.sessionController.rename({ sessionId, title: id })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 720)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(({ selected, workspace }) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: selected }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'workspace', orderBy: 'updated', groupExpansion: { [workspace]: true }, sessionOrderByAccount: {},
      }))
    }, { selected: SELECTED, workspace: workspaceId })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator(`[data-row-key="session:${SELECTED}"][aria-selected="true"]`).waitFor()
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  /** Read actual rendered geometry, not the inline placement declaration. */
  async function rect(locator: Locator) {
    return await locator.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    })
  }

  it.each(['workspace', 'session'] as const)('keeps the %s menu at its requested anchor with dismissal and focus return', async (kind) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-row-context-menu-${kind}`))
    await page.setViewportSize({ width: 1200, height: 720 })
    const row = page.locator(`[data-row-key="${kind}:${kind === 'workspace' ? workspaceId : TARGET}"]`)
    await row.waitFor()
    const trigger = row.getByRole('button', { name: /actions for/ })
    const menu = page.getByRole('menu')
    const expanded = await row.getAttribute('aria-expanded')
    for (const offset of [60, 120]) {
      const bounds = await rect(row)
      // Playwright sends the native pointerdown/mousedown/contextmenu sequence.
      await row.click({ button: 'right', position: { x: offset, y: bounds.height / 2 } })
      await menu.waitFor()
      await expect.poll(async () => Math.abs((await rect(menu)).x - (bounds.x + offset))).toBeLessThan(1)
      await expect.poll(async () => Math.abs((await rect(menu)).y - (bounds.y + bounds.height / 2 + 4))).toBeLessThan(1)
      expect(await menu.count()).toBe(1)
    }
    expect(await row.getAttribute('aria-expanded')).toBe(expanded)
    expect(await page.locator(`[data-row-key="session:${SELECTED}"]`).getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)

    for (const key of ['ContextMenu', 'Shift+F10']) {
      await row.focus()
      await page.keyboard.press(key)
      await menu.waitFor()
      await expect.poll(async () => {
        const anchor = await rect(row)
        const placed = await rect(menu)
        const viewportWidth = await page.evaluate(() => window.innerWidth)
        // Keyboard anchoring retains the shared menu's 12px viewport safety margin.
        const expectedX = Math.min(Math.max(anchor.x, 12), viewportWidth - placed.width - 12)
        return Math.abs(placed.x - expectedX)
      }).toBeLessThan(1)
      await expect.poll(async () => {
        const bounds = await rect(row)
        return Math.abs((await rect(menu)).y - (bounds.y + bounds.height + 4))
      }).toBeLessThan(1)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
    }
    await trigger.click()
    await menu.waitFor()
    await expect.poll(async () => Math.abs((await rect(menu)).x - (await rect(trigger)).x)).toBeLessThan(1)
    await expect.poll(async () => {
      const bounds = await rect(trigger)
      return Math.abs((await rect(menu)).y - (bounds.y + bounds.height + 4))
    }).toBeLessThan(1)
    await page.mouse.click(1000, 650)
    await menu.waitFor({ state: 'detached' })

    // A narrow, short viewport places the actual sidebar row near the menu's right/bottom limits.
    await page.setViewportSize({ width: 420, height: 340 })
    const reopen = page.getByRole('button', { name: 'Open sidebar', exact: true }).first()
    if (await reopen.isVisible()) await reopen.click()
    await row.scrollIntoViewIfNeeded()
    const bounds = await rect(row)
    await row.click({ button: 'right', position: { x: bounds.width - 16, y: bounds.height / 2 } })
    await menu.waitFor()
    for (const size of [{ width: 420, height: 340 }, { width: 390, height: 320 }]) {
      await page.setViewportSize(size)
      await expect.poll(async () => {
        const placed = await rect(menu)
        return placed.x >= 11 && placed.y >= 11
          && placed.x + placed.width <= size.width - 11
          && placed.y + placed.height <= size.height - 11
      }).toBe(true)
    }
    if (kind === 'session') {
      await menu.getByRole('menuitem', { name: 'Copy Session ID', exact: true }).click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(TARGET)
    } else {
      await page.keyboard.press('Escape')
    }
    await menu.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
  })
})
