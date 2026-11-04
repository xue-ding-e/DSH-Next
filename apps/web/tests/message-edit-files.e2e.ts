/** Preserve a committed file through browser Edit and resend using the shipped replay model. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import {
  launchWebScaffold, parseSeedFixture, renderSeedFixture, seedSession, selectedSessionFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SOURCE = SessionId('message-edit-files-source')
const REPLACEMENT = 'EDITED_FILE_MESSAGE Use the same report with this revised request.'
const RESPONSE = 'EDITED_FILE_REPLY The file was preserved in this branch.'
const BYTES = Uint8Array.of(0, 255, 13, 10, 42)

function continuation(): ReplayEntry[] {
  return [{ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: RESPONSE },
    { type: 'block-end', index: 0, block: { type: 'text', text: RESPONSE } },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 24 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }]
}

async function history(scaffold: WebScaffold, id: SessionId): Promise<readonly SessionEvent[]> {
  using source = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
  return [...source.events]
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: edit a human message with a generic file', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let file: FileAttachmentRef
  let originalText: string
  let originalSeq: number
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-message-edit-files-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(continuation()))
    scaffold = await launchWebScaffold({ replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride, paceMs: 5 })
    file = await scaffold.ctx.attachments.saveFile({ data: BYTES, name: 'preserved-report.bin' })
    const fixture = parseSeedFixture(await readFile(await selectedSessionFixture(SEED), 'utf8'))
    const original = fixture.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (original?.type !== 'user/message') throw new Error('message-edit file seed lacks a human message')
    originalText = original.data.content.filter(part => part.type === 'text').map(part => part.text).join('')
    originalSeq = original.seq
    const events = fixture.events.map(event => event === original
      ? { ...original, data: { ...original.data, content: [...original.data.content, { type: 'file' as const, attachment: file }] } }
      : event)
    await seedSession(scaffold, renderSeedFixture(fixture.headerLine, events), SOURCE)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const source = page.locator(`[data-row-key="recent-session:${SOURCE}"]`)
    await source.waitFor({ state: 'visible', timeout: 30_000 })
    await source.click()
    await page.getByText(file.name, { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
      .catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'message-edit files e2e cleanup failed')
  })

  it('keeps the attachment during cancellation, then sends the edited file message only to its child', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-edit-files'))
    const sourceBefore = await history(scaffold, SOURCE)
    const sessionCount = scaffold.ctx.sessions.list().length
    const row = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: originalText })
    await row.hover()
    await row.getByRole('button', { name: 'Edit and resend', exact: true }).click()
    const editor = row.getByRole('textbox', { name: 'Edit message', exact: true })
    await editor.fill('CANCELLED_FILE_EDIT')
    expect(await row.getByText(file.name, { exact: true }).count()).toBe(1)
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(scaffold.ctx.sessions.list()).toHaveLength(sessionCount)
    expect(await history(scaffold, SOURCE)).toEqual(sourceBefore)

    await row.getByRole('button', { name: 'Edit and resend', exact: true }).click()
    expect(await editor.inputValue()).toBe(originalText)
    await editor.fill(REPLACEMENT)
    const settled = scaffold.whenTurnSettled(60_000)
    await row.getByRole('button', { name: 'Save and send', exact: true }).click()
    const childId = await settled
    expect(childId).not.toBe(SOURCE)
    await page.getByText(RESPONSE, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText(file.name, { exact: true }).waitFor({ timeout: 15_000 })
    const child = scaffold.ctx.sessions.get(childId)
    if (child === undefined) throw new Error('edited file branch was not published')
    expect(child.inheritedEventCount).toBe(originalSeq)
    const users = (await history(scaffold, childId)).filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]?.type === 'user/message' && users[0].data.content).toEqual([
      { type: 'text', text: REPLACEMENT }, { type: 'file', attachment: file },
    ])
    const bytes: number[] = []
    for await (const chunk of scaffold.ctx.attachments.readFileStream(file)) bytes.push(...chunk)
    expect(bytes).toEqual([...BYTES])
    expect(scaffold.ctx.sessions.list()).toHaveLength(sessionCount + 1)
    expect(await history(scaffold, SOURCE)).toEqual(sourceBefore)

    await page.reload({ waitUntil: 'load' })
    await page.getByText(RESPONSE, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText(file.name, { exact: true }).waitFor({ timeout: 15_000 })
    await page.locator(`[data-row-key="recent-session:${SOURCE}"]`).click()
    await page.locator('[data-message-bubble]').filter({ hasText: originalText }).waitFor({ timeout: 15_000 })
    await page.getByText(file.name, { exact: true }).waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-message-bubble]').filter({ hasText: REPLACEMENT }).count()).toBe(0)
    expect(await history(scaffold, SOURCE)).toEqual(sourceBefore)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
