// Web e2e scenario: the shipped composition discovers local files and cold
// sessions through the real Host, groups both domains in the shared @ menu,
// and projects each pick as a complete inline range without issuing a model call.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-reference/types'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  readPersistedEvents,
  watchConsole,
  acknowledgeReloadConnectionLoss,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, pinBrowserClock, saveFailureShot, WEB_FIXTURE_TIME, writeComposerDraft } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/reference-composer', import.meta.url))
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const ORDER_EXPECTED = join(SNAPSHOT_DIR, 'order.expected.md')
const MODE = webSnapshotMode()
const SOURCE_SESSION_ID = 'reference-source-session'
const TARGET_SESSION_ID = 'reference-order-target-session'

async function settledSourceOption(menu: Locator): Promise<Locator> {
  await expect.poll(
    () => menu.getByRole('option', { name: new RegExp(TARGET_SESSION_ID) }).count(),
    { timeout: 15_000 },
  ).toBe(0)
  const source = menu.getByRole('option', { name: new RegExp(SOURCE_SESSION_ID) })
  await expect.poll(() => source.count(), { timeout: 15_000 }).toBe(1)
  return source
}

// Clear retained suggestions and insert one complete query so an intermediate
// prefix cannot satisfy the caller's wait for a ready result row.
async function replaceReferenceQuery(page: Page, input: Locator, text: string): Promise<void> {
  await writeComposerDraft(page, input, '')
  await page.getByRole('listbox', { name: 'Trigger suggestions' }).waitFor({ state: 'hidden' })
  await input.click()
  await page.keyboard.insertText(text)
}

/** Build one closed source session with a stable title for reference discovery. */
function sourceSessionFixture(): string {
  const session = Session.create(SessionId(SOURCE_SESSION_ID))
  session.append('turn/start', {
    turn: 1,
  })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Research context for the reference menu.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Research notes',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/** Build one target log with the direct message durably before its recalled context. */
function targetSessionFixture(): string {
  const session = Session.create(SessionId(TARGET_SESSION_ID))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '@Research notes what changed?' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '## Referenced sessions\n\n<referenced-sessions>snapshot</referenced-sessions>' }],
    source: {
      kind: 'session-reference',
      form: 'recall',
      version: 1,
      references: [{
        sessionId: SOURCE_SESSION_ID,
        label: 'Research notes',
        capturedThroughSeq: SessionSeq(4),
        compacted: false,
        originalMessages: 2,
        retainedMessages: 2,
        omittedMessages: 0,
        omittedBytes: 0,
        truncated: false,
        inputIndex: 0,
      }],
    },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Reference order target',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: file and session references through the real host', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const targetCreatedAt = WEB_FIXTURE_TIME - 60_000
    await seedSession(scaffold, sourceSessionFixture(), SOURCE_SESSION_ID, undefined, { createdAt: targetCreatedAt - 1 })
    await seedSession(scaffold, targetSessionFixture(), TARGET_SESSION_ID, undefined, { createdAt: targetCreatedAt })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    tripwire = watchConsole(page)
    // Fixture files land before the workspace connects so the Host's file
    // index never races their creation (the connect helper mkdirs the same
    // directory and tolerates it existing).
    await mkdir(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'reference.txt'), 'reference fixture\n')
    await mkdir(join(scaffold.workspaceCwd, 'workspace', 'folderx'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'folderx', 'child.txt'), 'child fixture\n')
    // Two levels down: the breadcrumb needs a step above the current one to
    // return to, and a bare '@' lists only the top level, so the deeper tree
    // stays out of the menu golden.
    await mkdir(join(scaffold.workspaceCwd, 'workspace', 'folderx', 'nested'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'folderx', 'nested', 'leaf.txt'), 'leaf fixture\n')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.each([
    ['recent', 'content', 1680], ['workspace', 'content', 1680],
    ['recent', 'rightbar', 1680], ['workspace', 'rightbar', 1680], ['recent', 'content', 390],
  ] as const)('drags a %s conversation onto %s at %ipx without losing its draft or reordering the sidebar', async (origin, destinationArea, width) => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-drag'))
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ colorScheme: origin === 'workspace' ? 'dark' : 'light' })
    const input = page.locator('[data-composer-input]').first()
    if (width === 390) {
      await writeComposerDraft(page, input, 'Keep this draft. ')
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    }
    if (origin === 'workspace') {
      const group = page.getByRole('treeitem', { name: /Ungrouped/ })
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    }
    const source = origin === 'recent'
      ? page.getByRole('region', { name: 'Recent', exact: true }).locator(`[data-row-key="recent-session:${SOURCE_SESSION_ID}"]`)
      : page.locator(`[data-row-key="session:${SOURCE_SESSION_ID}"]`)
    await source.waitFor()
    if (width !== 390) await writeComposerDraft(page, input, 'Keep this draft. ')
    if (destinationArea === 'rightbar') await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
    const destinationRegion = page.locator(destinationArea === 'rightbar' ? '[data-rightbar-col]' : '[data-conversation-content]').first()
    await expect.poll(async () => (await destinationRegion.boundingBox())?.width ?? 0).toBeGreaterThan(0)
    const order = await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5'))
    const from = await source.boundingBox()
    const destination = await destinationRegion.boundingBox()
    if (from === null || destination === null) throw new Error('Conversation drag targets are not visible')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 })
    if (origin === 'workspace') {
      const hovered = await page.locator(`[data-row-key="session:${TARGET_SESSION_ID}"]`).boundingBox()
      if (hovered === null) throw new Error('Sidebar reorder row is not visible')
      await page.mouse.move(hovered.x + hovered.width / 2, hovered.y + hovered.height / 2, { steps: 10 })
    }
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 3, { steps: 10 })
    const invitation = page.locator('[data-session-reference-drop]')
    await invitation.waitFor({ state: 'visible' })
    expect(await invitation.textContent()).toBe('Release to reference chat')
    const main = await page.locator('[data-main-column]').boundingBox()
    const mask = await invitation.boundingBox()
    if (main === null || mask === null) throw new Error('Drop invitation bounds are unavailable')
    expect(mask.x).toBeCloseTo(main.x, 0)
    expect(mask.width).toBeGreaterThanOrEqual(main.width)
    const hint = await invitation.locator('span').boundingBox()
    if (hint === null) throw new Error('Drop invitation text is unavailable')
    expect(hint.x).toBeGreaterThanOrEqual(mask.x)
    expect(hint.x + hint.width).toBeLessThanOrEqual(mask.x + mask.width)
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 10 })
    await invitation.waitFor({ state: 'hidden' })
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 3, { steps: 10 })
    await invitation.waitFor({ state: 'visible' })
    await page.screenshot({ path: join(SNAPSHOT_DIR, '..', '..', '..', '..', '..', '.playwright-mcp', `conversation-drop-${origin}-${destinationArea}-${width}.png`) })
    await page.mouse.up()
    await invitation.waitFor({ state: 'hidden' })
    const chip = input.locator('[data-composer-chip]')
    await expect.poll(() => chip.count()).toBe(1)
    expect(await chip.textContent()).toBe('Untitled')
    expect(await input.textContent()).toContain('Keep this draft.')
    await page.keyboard.insertText('Continue typing')
    expect(await input.textContent()).toContain('Continue typing')
    expect(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5'))).toBe(order)
    if (width === 390) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await writeComposerDraft(page, input, '')
    if (destinationArea === 'rightbar') await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('groups both sources and projects files and sessions as structured inline icon labels', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-composer'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await writeComposerDraft(page, input, '@')
    await expect.poll(() => menu.getByRole('option').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    // Session rows are dated from the live Host list, so their age bucket
    // advances while the suite runs.
    const snapshot = await captureStableAria(
      page, '[role="listbox"]', scaffold.workspaceCwd, {
        normalizeAge: true,
        replacements: [
          [abbreviateHomePath(scaffold.workspaceCwd, homedir()), '{{cwd}}'],
          [scaffold.workspaceCwd.replaceAll('\\', '\\\\'), '{{cwd}}'],
        ],
      },
    )
    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Files & folders')
    expect(snapshot).toContain('Sessions')
    expect(snapshot).not.toContain('text: reference Files & folders')
    expect(snapshot).toContain('reference.txt')
    // A seed reaches disk as a log alone, and the Host labels a session from
    // its projections: no checkpoint, so the row is its id. The fixture's own
    // title (`Research notes`) is unreachable here by construction, and the
    // package suite owns the titled paths.
    expect(snapshot).toContain(SOURCE_SESSION_ID)
    expect(snapshot).not.toContain('Research notes')
    expect(snapshot).not.toContain('text: Subagents')

    await writeComposerDraft(page, input, '@reference')
    // The open menu keeps the previous query's rows while the new one loads
    // (stale-while-revalidate), and rows are keyed by index, so a click
    // resolved against a stale row lands on whatever settles into that slot.
    // `folderx/` matches only the bare '@' query: its disappearance marks the
    // settled result set.
    await expect.poll(() => menu.getByRole('option', { name: /folderx/ }).count(), { timeout: 15_000 }).toBe(0)
    await menu.getByRole('option', { name: /reference\.txt/ }).click()
    // The pick lands an atomic chip: a real DOM capsule carrying the domain
    // icon and the label (the canonical reference text lives on the node and
    // expands on submit; the surface text is the label plus the separator).
    const fileReference = page.locator('[data-composer-chip]').last()
    await expect.poll(() => fileReference.textContent()).toBe('reference.txt')
    await expect.poll(() => fileReference.locator('svg').count()).toBe(1)
    await expect.poll(() => input.textContent()).toBe('reference.txt ')

    await writeComposerDraft(page, input, '@reference-source')
    await (await settledSourceOption(menu)).click()
    const sessionReference = page.locator('[data-composer-chip]').last()
    await expect.poll(() => sessionReference.textContent()).toBe(SOURCE_SESSION_ID)
    await expect.poll(() => sessionReference.locator('svg').count()).toBe(1)
    await expect.poll(() => input.textContent()).toBe(`${SOURCE_SESSION_ID} `)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('typing a trigger directly ahead of a chip inserts without disturbing it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-type-ahead'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await writeComposerDraft(page, input, '@reference.txt')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(0)
    await expect.poll(() => menu.getByRole('option').allTextContents()).toEqual(['reference.txt'])
    await menu.getByRole('option', { name: 'reference.txt', exact: true }).click()
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // The #2813 gesture: collapse the caret to the document start, directly
    // ahead of the chip, and open the trigger menu there.
    await input.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('@reference-source')
    await (await settledSourceOption(menu)).click()

    // Both chips survive the boundary insert: the session chip lands ahead of
    // the intact file chip.
    const chips = input.locator('[data-composer-chip]')
    await expect.poll(() => chips.count()).toBe(2)
    await expect.poll(() => chips.first().textContent()).toBe(SOURCE_SESSION_ID)
    await expect.poll(() => chips.last().textContent()).toBe('reference.txt')
    await expect.poll(() => input.textContent()).toBe(`${SOURCE_SESSION_ID} reference.txt `)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('arrows step across a chip in one move and Backspace removes it whole', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-keyboard'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await writeComposerDraft(page, input, '@reference.txt')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(0)
    await expect.poll(() => menu.getByRole('option').allTextContents()).toEqual(['reference.txt'])
    await menu.getByRole('option', { name: 'reference.txt', exact: true }).click()
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // First ArrowLeft crosses the trailing space; the second steps across the
    // chip in one move — no keyboard-selected intermediate state — and typing
    // continues normally on the far side.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('pre')
    await expect.poll(() => input.textContent()).toBe('prereference.txt ')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // A collapsed Backspace directly ahead of the chip removes the typed
    // character only; the chip's identity is untouched (#2814's gesture).
    await page.keyboard.press('Backspace')
    await expect.poll(() => input.textContent()).toBe('prreference.txt ')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)

    // ArrowRight steps back across the chip; Backspace directly behind it
    // removes the whole chip in one keystroke.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Backspace')
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(0)
    await expect.poll(() => input.textContent()).toBe('pr ')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('settles a folder as an atomic chip; Tab and the chevron drill instead', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-folder'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    // Settle: Enter on the highlighted folder row resolves the folder itself
    // as an atomic chip — folder glyph, no trigger character, one unit.
    await replaceReferenceQuery(page, input, '@folderx')
    // First folder query on this page: allow the Host index a cold start.
    await menu.getByRole('option', { name: /^folderx\// }).waitFor({ timeout: 60_000 })
    await page.keyboard.press('Enter')
    const chip = input.locator('[data-composer-chip]').last()
    await expect.poll(() => chip.textContent()).toBe('folderx/')
    await expect.poll(() => chip.locator('svg').count()).toBe(1)
    await expect.poll(() => input.textContent()).toBe('folderx/ ')

    // Tab drills: the literal descent text stays editable and the open menu
    // lists the folder's children.
    await replaceReferenceQuery(page, input, '@folderx')
    await menu.getByRole('option', { name: /^folderx\// }).waitFor()
    await page.keyboard.press('Tab')
    await expect.poll(() => input.textContent()).toBe('@folderx/')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor()

    // The row chevron drills the same way by pointer, header included: a
    // pointer descent reaches the same listing a Tab descent does.
    await replaceReferenceQuery(page, input, '@folderx')
    const row = menu.getByRole('option', { name: /^folderx\// })
    await row.waitFor()
    await row.getByRole('button', { name: 'Browse folder' }).click()
    await expect.poll(() => input.textContent()).toBe('@folderx/')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor()
    await expect.poll(() => page.getByRole('navigation', { name: 'Folder navigation' })
      .getByRole('button').allTextContents()).toEqual(['Workspace', 'folderx'])
    // The listing knows it was drilled into, so its rows drop the location the
    // header already carries.
    await expect.poll(() => menu.getByRole('option', { name: /child\.txt/ }).textContent())
      .toBe('child.txt')
    await page.keyboard.press('Escape')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('a drilled listing carries a breadcrumb back to the workspace root', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-breadcrumb'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    const crumbs = page.getByRole('navigation', { name: 'Folder navigation' })

    // A path the user typed carries its own context: no header.
    await replaceReferenceQuery(page, input, '@folderx/')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor({ timeout: 60_000 })
    await expect.poll(() => crumbs.count()).toBe(0)

    // The same listing reached by drilling owes the user the way back.
    await replaceReferenceQuery(page, input, '@folderx')
    await menu.getByRole('option', { name: /^folderx\// }).waitFor()
    await page.keyboard.press('Tab')
    await menu.getByRole('option', { name: /child\.txt/ }).waitFor()
    await crumbs.waitFor()
    await expect.poll(() => crumbs.getByRole('button').allTextContents())
      .toEqual(['Workspace', 'folderx'])
    // The listed folder is where the menu already is: its crumb is inert, and
    // the rows drop the location the header now carries.
    await expect.poll(() => crumbs.getByRole('button', { name: 'folderx' }).isDisabled()).toBe(true)
    await expect.poll(() => menu.getByRole('option', { name: /child\.txt/ }).textContent())
      .toBe('child.txt')

    // A crumb above the current step re-lists that directory and keeps the
    // header, which now names the step it returned to.
    await replaceReferenceQuery(page, input, '@folderx/nested')
    await expect.poll(() => menu.getByRole('option', { name: /child\.txt/ }).count()).toBe(0)
    const nested = menu.getByRole('option', { name: /^nested\// })
    await nested.waitFor()
    await nested.getByRole('button', { name: 'Browse folder' }).click()
    await expect.poll(() => input.textContent()).toBe('@folderx/nested/')
    await expect.poll(() => crumbs.getByRole('button').allTextContents())
      .toEqual(['Workspace', 'folderx', 'nested'])
    await crumbs.getByRole('button', { name: 'folderx' }).click()
    await expect.poll(() => input.textContent()).toBe('@folderx/')
    await expect.poll(() => crumbs.getByRole('button').allTextContents())
      .toEqual(['Workspace', 'folderx'])

    // Clicking the root crumb rewrites the token back to a bare trigger.
    await crumbs.getByRole('button', { name: 'Workspace' }).click()
    await expect.poll(() => input.textContent()).toBe('@')
    await expect.poll(() => crumbs.count()).toBe(0)
    await menu.getByRole('option', { name: /^folderx\// }).waitFor()
    await page.keyboard.press('Escape')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('renders the direct message followed by its logged recall as a collapsed Context row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-order'))
    const group = page.getByRole('treeitem', { name: /Ungrouped/ })
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    // Both logs were written behind the running Host and have no cache rows, so
    // cold listing uses their shared Workspace fallback. Explicit creation
    // times keep the target first without opening either body for a title.
    const groupSection = group.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
    const target = groupSection.locator('[role="treeitem"]').nth(1)
    await target.waitFor({ timeout: 15_000 })
    await target.click()
    await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'Research notes' }).waitFor({ timeout: 15_000 })
    const events = await readPersistedEvents(scaffold, SessionId(TARGET_SESSION_ID))
    const inputs = events.filter(event => event.type === 'user/message')
    expect(inputs.map(event => event.data.source.kind)).toEqual(['user', 'session-reference'])
    expect(inputs[0]?.seq).toBeLessThan(inputs[1]!.seq)
    expect(JSON.stringify(inputs[1]?.data)).toContain('<referenced-sessions>snapshot</referenced-sessions>')
    const recall = page.locator('[data-chat-flow-kind="context"]')
    expect(await recall.count()).toBe(1)
    expect(await recall.locator('[data-context-recall-icon]').count()).toBe(1)
    expect(await recall.locator('[aria-expanded]').getAttribute('aria-expanded')).toBe('false')
    // The recall follows the direct message, matching their logged order.
    expect(await page.locator('[data-chat-flow-kind="user"], [data-chat-flow-kind="context"]')
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-chat-flow-kind')))).toEqual(['user', 'context'])

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(TARGET_SESSION_ID).join('{{targetId}}')
    await compareOrRefreshGolden(ORDER_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Research notes what changed?')
    // The recall row folds into the settled Turn process.
    expect(snapshot).not.toContain('Session recall Research notes')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['menu.expected.md', 'order.expected.md'])
  })

  it('keeps the last opened conversation first across reload without changing the workspace tree', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-recent-order'))
    const recent = page.getByRole('region', { name: 'Recent', exact: true })
    const rows = recent.locator('[data-row-key^="recent-session:"]')
    const treeRows = page.locator('[role="treeitem"][data-row-key^="session:"]')
    const treeOrder = await treeRows.evaluateAll(elements => elements.map(element => element.getAttribute('data-row-key')))
    expect(treeOrder).toEqual(expect.arrayContaining([`session:${SOURCE_SESSION_ID}`, `session:${TARGET_SESSION_ID}`]))
    const openedAt = Date.now() + 60_000
    await page.clock.setFixedTime(openedAt)
    await recent.locator(`[data-row-key="recent-session:${SOURCE_SESSION_ID}"]`).click()
    await expect.poll(() => rows.first().getAttribute('data-row-key')).toBe(`recent-session:${SOURCE_SESSION_ID}`)
    await page.clock.setFixedTime(openedAt + 1_000)
    await recent.locator(`[data-row-key="recent-session:${TARGET_SESSION_ID}"]`).click()
    await expect.poll(() => rows.first().getAttribute('data-row-key')).toBe(`recent-session:${TARGET_SESSION_ID}`)
    expect(await treeRows.evaluateAll(elements => elements.map(element => element.getAttribute('data-row-key')))).toEqual(treeOrder)

    const warningStart = tripwire.warnings.length
    await page.reload()
    await recent.waitFor()
    await expect.poll(() => rows.first().getAttribute('data-row-key')).toBe(`recent-session:${TARGET_SESSION_ID}`)
    await expect.poll(() => treeRows.evaluateAll(elements => elements.map(element => element.getAttribute('data-row-key')))).toEqual(treeOrder)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
