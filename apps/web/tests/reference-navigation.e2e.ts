/** Real Host/browser coverage for Session-reference gestures, native selection, and retained drafts. */
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-reference/types'
import type {} from '@deepseek-ai/dsh-session-title'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

const SOURCE = SessionId('navigation-reference-source')
const TARGET = SessionId('navigation-reference-target')
const LABEL = 'Reference notes'

function fixtureLog(session: Session): string {
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

function fixture(id: SessionId): string {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  const text = id === SOURCE ? 'Source context for navigation.' : '@Reference notes check this.'
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  if (id === TARGET) session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Referenced context.' }],
    source: { kind: 'session-reference', form: 'recall', version: 1, references: [{
      sessionId: SOURCE, label: LABEL, capturedThroughSeq: SessionSeq(4), compacted: false,
      originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0,
    }] },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: id === SOURCE ? LABEL : 'Navigation target', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return fixtureLog(session)
}

const SAME_TITLE_FIRST = SessionId('reference-history-source-a')
const SAME_TITLE_SECOND = SessionId('reference-history-source-b')
const SAME_TITLE_HISTORY = SessionId('reference-history-origin')

function sameTitleSource(id: SessionId, text: string): string {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
  session.append('session/title', { title: LABEL, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return fixtureLog(session)
}

function sameTitleHistory(): string {
  const session = Session.create(SAME_TITLE_HISTORY)
  const messages: SessionSeq[] = []
  for (const [index, sessionId] of [SAME_TITLE_FIRST, SAME_TITLE_SECOND].entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    const question = index === 0 ? 'first historical question' : 'second historical question'
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `@${LABEL} ${question}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    messages.push(user.seq)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Captured reference context.' }],
      source: { kind: 'session-reference', form: 'recall', version: 1, references: [{
        sessionId, label: LABEL, capturedThroughSeq: SessionSeq(4), compacted: false,
        originalMessages: 1, retainedMessages: 1, omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0,
      }] },
    }), { surfaceOp: 'append' })
    if (index === 1) session.append('session/title', {
      title: 'History with matching reference labels', messageSeqs: messages, source: { kind: 'fallback' },
    })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return fixtureLog(session)
}

describe('web e2e: Session reference navigation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const input = (): Locator => page.locator('[contenteditable="true"][role="textbox"]')
  const bodyReference = (): Locator => page.locator('[data-session-reference-link]').first()
  const open = async (id: SessionId): Promise<void> => {
    const group = page.getByRole('treeitem', { name: /Ungrouped/ })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.locator(`[role="treeitem"][data-row-key="session:${id}"]`).click()
    await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: id === SOURCE ? 'Source context for navigation.' : 'check this.' }).waitFor()
  }
  const preset = async (label: string): Promise<void> => {
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'Session reference navigation', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await expect.poll(() => dialog.getByRole('button', { name: 'Session reference navigation', exact: true }).textContent()).toBe(label)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  const insert = async (): Promise<Locator> => {
    await writeComposerDraft(page, input(), 'draft before @')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await menu.getByRole('option', { name: new RegExp(`${SOURCE}|${LABEL}`) }).click()
    const chip = input().locator('[data-composer-chip]')
    await expect.poll(() => chip.count()).toBe(1)
    return chip
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
    await writeFile(join(scaffold.workspaceCwd, 'navigation-reference.md'), '# Reference preview regression\n')
    await seedSession(scaffold, fixture(SOURCE), SOURCE, undefined, { createdAt: Date.now() - 2_000 })
    await seedSession(scaffold, fixture(TARGET), TARGET, undefined, { createdAt: Date.now() - 1_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await open(TARGET)
  })

  afterAll(async () => { await browser?.close(); await scaffold?.close() })
  afterEach(async () => {
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    if (await dialog.count() > 0) await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const collapseRight = page.getByRole('button', { name: 'Collapse right sidebar', exact: true })
    if (await collapseRight.isVisible()) await collapseRight.click()
    await page.evaluate(() => { window.getSelection()?.removeAllRanges() })
  })

  it('opens the historical body reference on a default click and preserves the source draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-default'))
    await writeComposerDraft(page, input(), 'Unsent source draft')
    await bodyReference().click()
    await page.getByText('Source context for navigation.', { exact: true }).waitFor()
    await open(TARGET)
    await expect.poll(() => input().textContent()).toBe('Unsent source draft')
  })

  it('opens an atomic composer reference with the default single click and retains its identity', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-default-composer'))
    const chip = await insert()
    const before = await input().textContent()
    await chip.click()
    await page.getByText('Source context for navigation.', { exact: true }).waitFor()
    await open(TARGET)
    await expect.poll(() => input().textContent()).toBe(before)
    expect(await input().locator('[data-composer-chip]').count()).toBe(1)
  })

  it('paints a whole pill for keyboard ranges and select-all, and keeps drag selection in the source', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-selection'))
    const chip = await insert()
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(() => chip.getAttribute('data-selected')).toBe('')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.keyboard.press('ControlOrMeta+a')
      await expect.poll(() => chip.getAttribute('data-selected')).toBe('')
      const colors = await chip.locator(':scope > span').evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, color: style.color, shadow: style.boxShadow }
      })
      expect(colors.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(colors.color).not.toBe(colors.background)
      expect(colors.shadow).not.toBe('none')
    }
    await page.keyboard.press('ArrowRight')
    const box = await chip.boundingBox()
    const editorBox = await input().boundingBox()
    if (box === null || editorBox === null) throw new Error('Reference selection requires visible composer geometry')
    await page.mouse.move(editorBox.x + 3, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 5, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    expect(await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'check this.' }).count()).toBe(1)
    await expect.poll(() => chip.getAttribute('data-selected')).toBe('')
    await page.keyboard.press('ArrowRight')
  })

  it('applies the Ctrl or Meta preset to body references without activating an ordinary click', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-modifiers'))
    await preset('Ctrl / ⌘ + click')
    for (const modifier of ['Control', 'Meta'] as const) {
      await bodyReference().click()
      expect(await page.getByText('check this.', { exact: false }).count()).toBeGreaterThan(0)
      await bodyReference().click({ modifiers: [modifier] })
      await page.getByText('Source context for navigation.', { exact: true }).waitFor()
      await open(TARGET)
      const chip = await insert()
      await chip.click()
      expect(await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'check this.' }).count()).toBe(1)
      await chip.click({ modifiers: [modifier] })
      await page.getByText('Source context for navigation.', { exact: true }).waitFor()
      await open(TARGET)
    }
  })

  it('persists a custom double click with multiple modifiers through the Settings owner', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-custom'))
    await preset('Custom combination')
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByLabel('Click action', { exact: true }).selectOption('double')
    await expect.poll(() => dialog.getByLabel('Click action', { exact: true }).isEnabled()).toBe(true)
    for (const modifier of ['Ctrl', 'Alt / Option', 'Shift']) {
      await dialog.getByLabel(modifier, { exact: true }).check()
      await expect.poll(() => dialog.getByLabel(modifier, { exact: true }).isEnabled()).toBe(true)
    }
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'ui-conversation')?.value).toMatchObject({
      sessionReferenceNavigation: { gesture: 'custom', clicks: 'double', control: true, meta: false, alt: true, shift: true },
    })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await bodyReference().dblclick({ modifiers: ['Control', 'Shift'] })
    expect(await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'check this.' }).count()).toBe(1)
    await page.evaluate(() => { window.getSelection()?.removeAllRanges() })
    await bodyReference().dblclick({ modifiers: ['Control', 'Alt', 'Shift'] })
    await page.getByText('Source context for navigation.', { exact: true }).waitFor()
    await open(TARGET)
    const chip = await insert()
    await chip.dblclick({ modifiers: ['Control', 'Alt', 'Shift'] })
    await page.getByText('Source context for navigation.', { exact: true }).waitFor()
    await open(TARGET)
  })

  it('uses double-click navigation inside the composer and restores its atomic draft after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-composer'))
    await preset('Double click')
    const chip = await insert()
    const before = await input().textContent()
    await chip.click()
    expect(await input().textContent()).toBe(before)
    await chip.dblclick()
    await page.getByText('Source context for navigation.', { exact: true }).waitFor()
    await open(TARGET)
    await expect.poll(() => input().textContent()).toBe(before)
    expect(await input().locator('[data-composer-chip]').count()).toBe(1)
    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'check this.' }).waitFor()
    await expect.poll(() => input().textContent()).toBe(before)
    await input().locator('[data-composer-chip]').click()
    expect(await input().textContent()).toBe(before)
    await input().locator('[data-composer-chip]').dblclick()
    await page.getByText('Source context for navigation.', { exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps file-chip previews on a single click when Session references require a double click', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-file-preview'))
    await open(TARGET)
    await writeComposerDraft(page, input(), '@navigation-reference')
    await page.getByRole('listbox', { name: 'Trigger suggestions' }).getByRole('option', { name: /navigation-reference\.md/ }).click()
    const before = await input().textContent()
    await input().locator('[data-composer-chip]').click()
    await page.getByRole('heading', { name: 'Reference preview regression', exact: true }).waitFor()
    expect(await input().textContent()).toBe(before)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the preset and custom modifier controls within a 390px viewport', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-phone'))
    const previous = page.viewportSize()
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await openSettings(page, 'en')
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      const selector = dialog.getByRole('button', { name: 'Session reference navigation', exact: true })
      await selector.scrollIntoViewIfNeeded()
      const box = await selector.boundingBox()
      if (box === null) throw new Error('Reference navigation setting is not visible')
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      await selector.click()
      await page.getByRole('menuitem', { name: 'Custom combination', exact: true }).click()
      await dialog.getByRole('checkbox', { name: 'Shift', exact: true }).scrollIntoViewIfNeeded()
      expect(await dialog.getByRole('checkbox').count()).toBe(4)
      const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth)
      expect(overflow).toBe(false)
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally {
      if (previous !== null) await page.setViewportSize(previous)
    }
  })
})

describe('web e2e: historical Session references with matching labels', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const input = (): Locator => page.locator('[contenteditable="true"][role="textbox"]')
  const openHistory = async (): Promise<void> => {
    const group = page.getByRole('treeitem', { name: /Ungrouped/ })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.locator(`[role="treeitem"][data-row-key="session:${SAME_TITLE_HISTORY}"]`).click()
    await page.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'second historical question' }).waitFor()
    await page.getByRole('link', { name: LABEL, exact: true }).nth(1).waitFor()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)) })
    await seedSession(scaffold, sameTitleSource(SAME_TITLE_FIRST, 'First matching-label source context.'), SAME_TITLE_FIRST,
      undefined, { createdAt: Date.now() - 3_000 })
    await seedSession(scaffold, sameTitleSource(SAME_TITLE_SECOND, 'Second matching-label source context.'), SAME_TITLE_SECOND,
      undefined, { createdAt: Date.now() - 2_000 })
    await seedSession(scaffold, sameTitleHistory(), SAME_TITLE_HISTORY, undefined, { createdAt: Date.now() - 1_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await openHistory()
  })

  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('opens each historical message’s captured ID and preserves the originating draft after both mouse navigations', async () => {
    onTestFailed(() => saveFailureShot(page, 'reference-navigation-same-title-history'))
    const draft = 'Keep this source draft while following historical references.'
    expect(await page.getByRole('link', { name: LABEL, exact: true }).count()).toBe(2)
    await writeComposerDraft(page, input(), draft)
    for (const { question, expected, other } of [
      { question: 'first historical question', expected: 'First matching-label source context.', other: 'Second matching-label source context.' },
      { question: 'second historical question', expected: 'Second matching-label source context.', other: 'First matching-label source context.' },
    ]) {
      const message = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: question })
      await message.getByRole('link', { name: LABEL, exact: true }).click()
      await page.getByText(expected, { exact: true }).waitFor()
      expect(await page.getByText(other, { exact: true }).count()).toBe(0)
      await openHistory()
      await expect.poll(() => input().textContent()).toBe(draft)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
