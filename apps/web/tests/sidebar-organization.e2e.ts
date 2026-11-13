/** Browser interactions and persistence for sidebar organization and custom sections. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const TITLES = ['ORGANIZATION Alpha', 'ORGANIZATION Bravo', 'ORGANIZATION Charlie'] as const
const WORKSPACE_TITLE = 'ORGANIZATION Workspace'

/** The real persisted recent-section list, independent of its scroll position. */
function recent(page: Page): Locator {
  return page.locator('[data-sidebar-recent]')
}

/** Read row order without including hover action labels. */
function recentTitles(page: Page): Promise<string[]> {
  return recent(page).locator('[data-row-key^="recent-session:"] [class*="sessionTitle"]').allTextContents()
}

/** Reveal a section's own options before choosing a submenu. */
async function sectionOptions(section: Locator): Promise<void> {
  const trigger = section.locator('button[aria-haspopup="menu"]').first()
  await section.getByRole('button', { name: /^(Recent|Pinned|ORGANIZATION .*)$/ }).first().hover()
  await trigger.click()
}

/** Open a submenu through the actual pointer interaction rather than force clicking hidden items. */
async function chooseSubmenu(page: Page, trigger: string, choice: string): Promise<void> {
  await sectionOptions(recent(page))
  await page.getByRole('menuitem', { name: trigger, exact: true }).hover()
  await page.getByRole('menuitem', { name: choice, exact: true }).click()
}

/** Open the shared session action menu from a visible sidebar row. */
async function rowOptions(section: Locator, title: string): Promise<void> {
  const row = section.locator('[data-row-key]').filter({
    has: section.page().getByText(title, { exact: true }),
  })
  await row.hover()
  await row.getByRole('button', { name: `Session actions for ${title}`, exact: true }).click()
}

describe('web e2e: sidebar organization', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  async function reload(): Promise<void> {
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await recent(page).waitFor({ state: 'attached', timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.configure(WORKSPACE_TITLE)
    const now = Date.now()
    for (const [index, title] of TITLES.entries()) {
      const id = await seedSession(scaffold, fixture, `sidebar-organization-${index}`, undefined, {
        createdAt: now - (index + 1) * 60_000,
      })
      await workspace.attachSession(id)
      await scaffold.ctx.sessionController.rename({ sessionId: id, title })
    }
    browser = await chromium.launch()
  }, 180_000)

  beforeEach(async () => {
    page = await newEnglishPage(browser, 900)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-sidebar-recent]', { timeout: 30_000 })
    await expect.poll(() => recentTitles(page), { timeout: 15_000 }).toHaveLength(TITLES.length)
  })

  afterEach(async () => {
    try {
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      await page?.context().close()
    }
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps Recent visible and usable when an empty search is opened', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-empty-search'))
    const section = recent(page)
    const heading = section.getByRole('button', { name: 'Recent', exact: true })
    const input = page.getByPlaceholder('Search session names', { exact: true })
    const search = section.getByRole('button', { name: 'Search chats', exact: true })
    const originalTitles = await recentTitles(page)
    const element = await section.elementHandle()
    if (element === null) throw new Error('Recent section is missing')
    try {
      await search.click()
      await expect.poll(() => input.evaluate(input => input === document.activeElement)).toBe(true)
      expect(await element.evaluate(section => section.isConnected)).toBe(true)
      expect(await section.isVisible()).toBe(true)
      expect(await recentTitles(page)).toEqual(originalTitles)
      await input.fill('   ')
      expect(await section.isVisible()).toBe(true)
      await input.fill('ORGANIZATION Alpha')
      await page.getByRole('tree', { name: 'Search results', exact: true }).waitFor()
      expect(await section.count()).toBe(0)
      await input.fill('')
      await section.waitFor({ state: 'visible' })
      expect(await recentTitles(page)).toEqual(originalTitles)
      await input.press('Escape')

      await heading.click()
      await expect.poll(() => heading.getAttribute('aria-expanded')).toBe('false')
      await search.click()
      expect(await section.isVisible()).toBe(true)
      expect(await heading.getAttribute('aria-expanded')).toBe('false')
      await input.press('Escape')
      await heading.click()
      await expect.poll(() => heading.getAttribute('aria-expanded')).toBe('true')
      await search.click()
      await section.locator('[data-row-key^="recent-session:"]').first().click()
      await expect.poll(() => page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session'))
        .toBeTruthy()
      expect(await section.isVisible()).toBe(true)
    } finally {
      await element.dispose()
    }
  })

  it('persists the collapsed Recent section across reload without hiding its options', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-collapse'))
    const heading = recent(page).getByRole('button', { name: 'Recent', exact: true })
    const expandedHeight = await recent(page).evaluate(section => section.getBoundingClientRect().height)
    await heading.click()
    await expect.poll(() => heading.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => recent(page).evaluate(section => section.getBoundingClientRect().height))
      .toBeLessThan(expandedHeight - 60)
    await reload()
    await expect.poll(() => heading.getAttribute('aria-expanded')).toBe('false')
    expect(await recent(page).evaluate(section => section.getBoundingClientRect().height)).toBeLessThan(expandedHeight - 60)
    await sectionOptions(recent(page))
    await page.getByRole('menuitem', { name: 'Organize sidebar', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await heading.click()
    await expect.poll(() => heading.getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => recentTitles(page)).toHaveLength(TITLES.length)
  })

  it('switches workspace grouping and restores the project visibility control after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-grouping'))
    const tree = page.getByRole('tree', { name: 'Sessions', exact: true })
    const workspace = tree.getByText(WORKSPACE_TITLE, { exact: true })
    await workspace.waitFor()
    await chooseSubmenu(page, 'Organize sidebar', 'Combined view')
    await expect.poll(() => workspace.count()).toBe(0)
    await reload()
    expect(await workspace.count()).toBe(0)
    await chooseSubmenu(page, 'Organize sidebar', 'Group by project')
    await workspace.waitFor()
    await sectionOptions(recent(page))
    await page.getByRole('menuitem', { name: 'Projects', exact: true }).click()
    await expect.poll(() => tree.isVisible()).toBe(false)
    await reload()
    expect(await tree.isVisible()).toBe(false)
    // Recent remains the recovery control even while the project area is hidden.
    await sectionOptions(recent(page))
    const projects = page.getByRole('menuitem', { name: 'Projects', exact: true })
    await projects.click()
    await workspace.waitFor()
  })

  it('persists a manual drag order and restores updated ordering through the Recent menu', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-order'))
    const updated = await recentTitles(page)
    await chooseSubmenu(page, 'Sort chats', 'Manual order')
    const source = recent(page).locator('[data-row-key^="recent-session:"]')
      .filter({ has: page.getByText(updated[2]!, { exact: true }) })
    const target = recent(page).locator('[data-row-key^="recent-session:"]')
      .filter({ has: page.getByText(updated[0]!, { exact: true }) })
    await source.dragTo(target, { targetPosition: { x: 32, y: 3 } })
    const moved = [updated[2], updated[0], updated[1]]
    await expect.poll(() => recentTitles(page)).toEqual(moved)
    await reload()
    await expect.poll(() => recentTitles(page)).toEqual(moved)
    await chooseSubmenu(page, 'Sort chats', 'Recently updated')
    await expect.poll(() => recentTitles(page)).toEqual(updated)
    await reload()
    await expect.poll(() => recentTitles(page)).toEqual(updated)
  })

  it('places pinned chats above projects and Recent below them, including after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-pinned'))
    const pinned = page.getByRole('region', { name: 'Pinned', exact: true })
    await rowOptions(recent(page), TITLES[0])
    await page.getByRole('menuitem', { name: 'Pin session', exact: true }).click()
    try {
      await pinned.getByText(TITLES[0], { exact: true }).waitFor()
      const order = () => pinned.evaluate((section) => {
        const projects = document.querySelector('[data-sidebar-workspace-header]')!
        const tree = projects.parentElement?.querySelector('[role="tree"]')
        const recent = projects.parentElement?.querySelector('[data-sidebar-section="recent"]')
        return {
          beforeProjects: Boolean(section.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING),
          recentAfterTree: tree != null && recent != null
            && Boolean(tree.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING),
          bottom: section.getBoundingClientRect().bottom,
          projectTop: projects.getBoundingClientRect().top,
        }
      })
      const initialOrder = await order()
      expect(initialOrder.beforeProjects).toBe(true)
      expect(initialOrder.recentAfterTree).toBe(true)
      expect(initialOrder.bottom).toBeLessThanOrEqual(initialOrder.projectTop)
      await reload()
      await pinned.getByText(TITLES[0], { exact: true }).waitFor()
      expect((await order()).recentAfterTree).toBe(true)
      await rowOptions(pinned, TITLES[0])
      await page.getByRole('menuitem', { name: 'Unpin session', exact: true }).click()
      await recent(page).getByText(TITLES[0], { exact: true }).waitFor()
      expect(await pinned.count()).toBe(0)
    } finally {
      // Keep the shared Host's pin catalog independent of a failed browser case.
      await scaffold.ctx.workspaceRegistry.unpinSession(SessionId('sidebar-organization-0'))
    }
  })

  it('creates and renames a section, moves a chat, and returns it to Recent on section deletion', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-sections'))
    await sectionOptions(recent(page))
    await page.getByRole('menuitem', { name: 'New section', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New section', exact: true })
    await create.getByRole('textbox', { name: 'Section name', exact: true }).fill('ORGANIZATION Section')
    await create.getByRole('button', { name: 'Save', exact: true }).click()
    const section = page.getByRole('region', { name: 'ORGANIZATION Section', exact: true })
    await section.waitFor()
    await sectionOptions(section)
    await page.getByRole('menuitem', { name: 'Rename section', exact: true }).click()
    const rename = page.getByRole('dialog', { name: 'Rename section', exact: true })
    await rename.getByRole('textbox', { name: 'Section name', exact: true }).fill('ORGANIZATION Renamed')
    await rename.getByRole('button', { name: 'Save', exact: true }).click()
    const renamed = page.getByRole('region', { name: 'ORGANIZATION Renamed', exact: true })
    await renamed.waitFor()
    await rowOptions(recent(page), TITLES[1])
    await page.getByRole('menuitem', { name: 'Move to section', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'ORGANIZATION Renamed', exact: true }).click()
    await renamed.getByText(TITLES[1], { exact: true }).waitFor()
    expect(await recent(page).getByText(TITLES[1], { exact: true }).count()).toBe(0)
    await reload()
    await renamed.getByText(TITLES[1], { exact: true }).waitFor()
    await sectionOptions(renamed)
    await page.getByRole('menuitem', { name: 'Delete section', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete section', exact: true })
      .getByRole('button', { name: 'Delete section', exact: true }).click()
    await renamed.waitFor({ state: 'detached' })
    await recent(page).getByText(TITLES[1], { exact: true }).waitFor()
    await reload()
    expect(await renamed.count()).toBe(0)
    await expect.poll(() => recentTitles(page)).toHaveLength(TITLES.length)
  })

  it('creates a blank chat in its custom section before opening it without issuing a model turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-new-section-chat'))
    await sectionOptions(recent(page))
    await page.getByRole('menuitem', { name: 'New section', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New section', exact: true })
    await create.getByRole('textbox', { name: 'Section name', exact: true }).fill('ORGANIZATION New chat')
    await create.getByRole('button', { name: 'Save', exact: true }).click()
    const section = page.getByRole('region', { name: 'ORGANIZATION New chat', exact: true })
    await section.getByRole('button', { name: 'New session', exact: true }).click()
    await expect.poll(() => page.evaluate(() => {
      const current = JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null') as { sessionId?: string } | null
      const view = JSON.parse(localStorage.getItem('dsh.workspace.view.v5') ?? 'null') as {
        sidebar?: { sections: { title: string; sessionIds: string[] }[] }
      } | null
      const membership = view?.sidebar?.sections.find(item => item.title === 'ORGANIZATION New chat')
      return current?.sessionId !== undefined && membership?.sessionIds.includes(current.sessionId) === true
    }), { timeout: 15_000 }).toBe(true)
    const sessionId = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('dsh.sessions.current')!) as { sessionId: string }).sessionId)
    expect(TITLES.map((_title, index) => `sidebar-organization-${index}`)).not.toContain(sessionId)
    await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor()
    expect(await page.locator('[data-user-message]').count()).toBe(0)
    await expect.poll(() => recentTitles(page)).toHaveLength(TITLES.length)
  })

  it('keeps nested menus in a narrow viewport and dismisses them with Escape and outside input', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-organization-menu-dismissal'))
    await page.setViewportSize({ width: 880, height: 500 })
    await expect.poll(() => page.locator('[data-app-frame]').getAttribute('data-sidebar-collapsed')).toBe('true')
    await page.locator('[data-sidebar-toggle]').click()
    await recent(page).getByRole('button', { name: 'Recent', exact: true }).waitFor()
    await sectionOptions(recent(page))
    await page.getByRole('menuitem', { name: 'Organize sidebar', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'Group by project', exact: true }).waitFor()
    const bounds = await page.getByRole('menu').evaluateAll(menus => menus.map((menu) => {
      const box = menu.getBoundingClientRect()
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    }))
    expect(bounds.length).toBeGreaterThanOrEqual(2)
    for (const box of bounds) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(880)
      expect(box.bottom).toBeLessThanOrEqual(500)
    }
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menuitem', { name: 'Group by project', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    await sectionOptions(recent(page))
    await page.getByRole('menuitem', { name: 'Sort chats', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'Recently updated', exact: true }).waitFor()
    await page.mouse.click(850, 100)
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
  })
})
