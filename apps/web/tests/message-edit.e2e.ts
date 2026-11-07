/** Edit a committed user message through the assembled browser and retain its source log. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold, parseSeedFixture, seedSession, selectedSessionFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SOURCE = SessionId('message-edit-source')
const REPLACEMENT = 'EDITED_USER_MESSAGE Explain this revision without running tools.'
const RESPONSE = 'EDITED_MESSAGE_REPLY The replacement reached this branch.'

function continuation(): ReplayEntry[] {
  return [{ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: RESPONSE },
    { type: 'block-end', index: 0, block: { type: 'text', text: RESPONSE } },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 24 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }]
}

async function readSource(scaffold: WebScaffold): Promise<readonly SessionEvent[]> {
  using observation = await scaffold.ctx.sessionQuery.observeSession(SOURCE, { projectionMode: 'none' })
  return [...observation.events]
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: edit and resend a previous user message', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let originalText: string
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(continuation()))
    scaffold = await launchWebScaffold({ replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride, paceMs: 5 })
    const fixture = await readFile(await selectedSessionFixture(SEED), 'utf8')
    const original = parseSeedFixture(fixture).events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (original?.type !== 'user/message') throw new Error('message-edit seed lacks a human message')
    originalText = original.data.content.filter(part => part.type === 'text').map(part => part.text).join('')
    await seedSession(scaffold, fixture, SOURCE)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const source = page.locator(`[data-row-key="recent-session:${SOURCE}"]`)
    await source.waitFor({ state: 'visible', timeout: 30_000 })
    await source.click()
    await page.locator('[data-message-bubble]').filter({ hasText: originalText }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
      .catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'message-edit e2e cleanup failed')
  })

  it('cancels locally, then confirms one replacement in the original Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-edit'))
    const sourceBefore = await readSource(scaffold)
    const sessionCount = scaffold.ctx.sessions.list().length
    const composer = page.locator('[data-composer-input]').last()
    await writeComposerDraft(page, composer, 'Keep the original conversation draft')
    const row = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: originalText })
    await row.hover()
    await row.getByRole('button', { name: 'Edit and resend', exact: true }).click()
    const editor = row.getByRole('textbox', { name: 'Edit message', exact: true })
    expect(await editor.inputValue()).toBe(originalText)
    await editor.fill('CANCELLED_EDIT_MUST_NOT_SEND')
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await editor.count()).toBe(0)
    expect(scaffold.ctx.sessions.list()).toHaveLength(sessionCount)
    expect(await composer.innerText()).toBe('Keep the original conversation draft')
    expect(await readSource(scaffold)).toEqual(sourceBefore)

    await row.getByRole('button', { name: 'Edit and resend', exact: true }).click()
    expect(await editor.inputValue()).toBe(originalText)
    await editor.fill(REPLACEMENT)
    const settled = scaffold.whenTurnSettled(60_000)
    await row.getByRole('button', { name: 'Save and send', exact: true }).click()
    const editedSessionId = await settled
    expect(editedSessionId).toBe(SOURCE)
    await page.getByText(RESPONSE, { exact: true }).waitFor({ timeout: 15_000 })
    await page.locator('[data-message-bubble]').filter({ hasText: REPLACEMENT }).waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-message-bubble]').filter({ hasText: originalText }).count()).toBe(0)

    const editedSession = scaffold.ctx.sessions.get(SOURCE)
    if (editedSession === undefined) throw new Error('edited Session was detached')
    const users = editedSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(users.length).toBeGreaterThan(1)
    const lastUser = users.at(-1)
    expect(lastUser?.type === 'user/message' ? lastUser.data.content : undefined)
      .toEqual([{ type: 'text', text: REPLACEMENT }])
    expect(scaffold.ctx.sessions.list()).toHaveLength(sessionCount)
    const sourceAfter = await readSource(scaffold)
    expect(sourceAfter.slice(0, sourceBefore.length)).toEqual(sourceBefore)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
