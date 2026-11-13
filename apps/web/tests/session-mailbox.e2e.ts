/** Exercise explicit mailbox delivery through the composed Web client and Host. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

it('queues an explicit message, reads it in the destination, and acknowledges it without a model turn', async () => {
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [] } })
  onTestFinished(() => scaffold.close())
  const recording = await readFile(FIXTURE, 'utf8')
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const source = await seedSession(scaffold, recording, 'mailbox-browser-source')
  const target = await seedSession(scaffold, recording, 'mailbox-browser-target')
  for (const [id, title] of [[source, 'Mailbox source'], [target, 'Mailbox destination']] as const) {
    await workspace.attachSession(id)
    await scaffold.ctx.sessionController.rename({ sessionId: id, title })
  }

  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    const openChat = async (title: string) => {
      await page.getByRole('region', { name: 'Recent', exact: true }).getByRole('button', { name: title, exact: true }).click()
      await page.getByRole('navigation', { name: 'Session hierarchy' }).getByText(title, { exact: true }).waitFor()
    }
    const openMailbox = async () => {
      try {
        await page.getByRole('button', { name: 'Session mailbox', exact: true }).click({ timeout: 10_000 })
      } catch (error) {
        throw new Error(JSON.stringify({ errors: tripwire.pageErrors, warnings: tripwire.warnings }), { cause: error })
      }
      const dialog = page.getByRole('dialog', { name: 'Session mailbox', exact: true })
      await dialog.waitFor()
      return dialog
    }

    await openChat('Mailbox source')
    const send = await openMailbox()
    await send.getByLabel('Destination').selectOption({ label: 'Mailbox destination' })
    await send.getByLabel('Message', { exact: true }).fill('A queued mailbox message')
    const targetBefore = scaffold.ctx.agents.get(target)
    const targetEvents = targetBefore?.session.snapshotEvents().length
    await send.getByRole('button', { name: 'Confirm queue-only send' }).click()
    await send.getByText('Queued. The destination Agent was not started.', { exact: true }).waitFor()
    const targetAfter = scaffold.ctx.agents.get(target)
    expect(targetAfter === targetBefore).toBe(true)
    expect(targetAfter?.session.snapshotEvents().length).toBe(targetEvents)
    await send.getByRole('button', { name: 'Close', exact: true }).click()
    await openChat('Mailbox destination')
    const receive = await openMailbox()
    await receive.getByRole('button', { name: 'Read this session’s inbox' }).click()
    const record = receive.getByRole('listitem').filter({ hasText: 'A queued mailbox message' })
    await record.waitFor()
    const acknowledge = record.getByRole('button', { name: 'Acknowledge read' })
    await acknowledge.click()
    await expect.poll(() => acknowledge.isDisabled()).toBe(true)
    await record.getByText(/acknowledged/).waitFor()
    expect(scaffold.ctx.agents.get(target)?.status ?? 'idle').toBe('idle')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
  }
})
