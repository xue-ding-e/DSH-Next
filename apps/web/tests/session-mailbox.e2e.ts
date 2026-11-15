/** Exercise explicit mailbox delivery through the composed Web client and Host. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    await send.getByRole('button', { name: 'Destination', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mailbox destination', exact: true }).click()
    await send.getByLabel('Message', { exact: true }).fill('A queued mailbox message')
    const targetBefore = scaffold.ctx.agents.get(target)
    const targetEvents = targetBefore?.session.snapshotEvents().length
    await send.getByRole('button', { name: 'Send to mailbox' }).click()
    await send.getByText('Queued. The destination Agent was not started.', { exact: true }).waitFor()
    const targetAfter = scaffold.ctx.agents.get(target)
    expect(targetAfter === targetBefore).toBe(true)
    expect(targetAfter?.session.snapshotEvents().length).toBe(targetEvents)
    await send.getByRole('button', { name: 'Close', exact: true }).click()
    await openChat('Mailbox destination')
    const receive = await openMailbox()
    await receive.getByRole('button', { name: 'Read inbox' }).click()
    const record = receive.getByRole('listitem').filter({ hasText: 'A queued mailbox message' })
    await record.waitFor()
    const acknowledge = record.getByRole('button', { name: 'Mark as read' })
    await acknowledge.click()
    await record.getByText('Read', { exact: true }).waitFor()
    expect(await acknowledge.count()).toBe(0)
    await record.getByText('Mailbox source', { exact: true }).waitFor()
    expect(scaffold.ctx.agents.get(target)?.status ?? 'idle').toBe('idle')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
  }
})

it('keeps destination menus readable, bounded and keyboard accessible in both themes and a narrow window', async () => {
  const scaffold = await launchWebScaffold({ profile: { hmr: false, packages: [] } })
  onTestFinished(() => scaffold.close())
  const recording = await readFile(FIXTURE, 'utf8')
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  for (let index = 0; index < 22; index++) {
    const id = await seedSession(scaffold, recording, `mailbox-layout-target-${index}`)
    await workspace.attachSession(id)
    await scaffold.ctx.sessionController.rename({
      sessionId: id, title: `Mailbox destination ${String(index).padStart(2, '0')} · ${'Long conversation title '.repeat(5)}`,
    })
  }
  const source = await seedSession(scaffold, recording, 'mailbox-layout-source')
  await workspace.attachSession(source)
  await scaffold.ctx.sessionController.rename({ sessionId: source, title: 'Mailbox layout source' })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser, 900)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('region', { name: 'Recent', exact: true })
      .getByRole('button', { name: 'Mailbox layout source', exact: true }).click()
    await page.getByRole('button', { name: 'Session mailbox', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Session mailbox', exact: true })
    const target = dialog.getByRole('button', { name: 'Destination', exact: true })
    const draft = dialog.getByLabel('Message', { exact: true })
    await draft.fill('Preserve this mailbox draft')
    const screenshots = fileURLToPath(new URL('../../../.playwright-mcp/mailbox-ui/', import.meta.url))
    await mkdir(screenshots, { recursive: true })
    for (const scene of [
      { colorScheme: 'dark' as const, width: 1366, height: 900 },
      { colorScheme: 'light' as const, width: 1366, height: 900 },
      { colorScheme: 'dark' as const, width: 390, height: 740 },
    ]) {
      await page.setViewportSize({ width: scene.width, height: scene.height })
      await page.emulateMedia({ colorScheme: scene.colorScheme })
      await expect.poll(() => page.locator('body').evaluate(element => element.hasAttribute('data-ds-dark-theme')))
        .toBe(scene.colorScheme === 'dark')
      await target.click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      expect(await menu.getByRole('menuitem').count()).toBe(22)
      expect(await menu.getByRole('menuitem', { name: 'Mailbox layout source', exact: true }).count()).toBe(0)
      const bounds = await menu.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(11)
      expect(bounds!.y).toBeGreaterThanOrEqual(11)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(scene.width - 11)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(scene.height - 11)
      expect(bounds!.height).toBeLessThanOrEqual(281)
      expect(bounds!.width).toBeCloseTo((await target.boundingBox())!.width, 0)
      const row = menu.getByRole('menuitem').first()
      const appearance = await row.evaluate((element) => {
        const style = getComputedStyle(element)
        return { color: style.color, fontSize: style.fontSize }
      })
      expect(appearance.fontSize).toBe('13px')
      const color = appearance.color.match(/[\d.]+/gu)!.slice(0, 3).map(Number)
      if (scene.colorScheme === 'dark') expect(Math.min(...color)).toBeGreaterThan(180)
      else expect(Math.max(...color)).toBeLessThan(100)
      await page.screenshot({ path: join(screenshots, `${scene.colorScheme}-${scene.width}-open.png`) })
      await page.keyboard.press('Escape')
      expect(await menu.count()).toBe(0)
      expect(await dialog.isVisible()).toBe(true)
      expect(await draft.inputValue()).toBe('Preserve this mailbox draft')
      await expect.poll(() => target.evaluate(element => document.activeElement === element)).toBe(true)
      const field = await draft.boundingBox()
      expect(field!.x + field!.width).toBeLessThanOrEqual(scene.width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.setViewportSize({ width: 1366, height: 900 })
    await target.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    expect(await page.getByRole('menu').count()).toBe(0)
    expect(await target.textContent()).toContain('Mailbox destination')
    expect(await draft.inputValue()).toBe('Preserve this mailbox draft')
    await target.click()
    await dialog.getByRole('heading', { name: 'Session mailbox', exact: true }).click()
    expect(await page.getByRole('menu').count()).toBe(0)
    await draft.click()
    await dialog.getByRole('button', { name: 'Read inbox', exact: true }).click()
    await dialog.getByText('No messages in this inbox', { exact: true }).waitFor()
    await page.screenshot({ path: join(screenshots, 'dark-empty-inbox.png') })
    const chinese = await browser.newPage({
      locale: 'zh-CN', viewport: { width: 1366, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce',
    })
    await chinese.goto(scaffold.authenticatedUrl)
    await chinese.getByRole('region', { name: '最近', exact: true })
      .getByRole('button', { name: 'Mailbox layout source', exact: true }).click()
    await chinese.getByRole('button', { name: '会话信箱', exact: true }).click()
    await chinese.getByRole('dialog', { name: '会话信箱', exact: true }).getByLabel('消息', { exact: true }).fill('请在完成检查后，把结果发送到这个会话的信箱')
    await chinese.getByRole('button', { name: '目标会话', exact: true }).click()
    await chinese.screenshot({ path: join(screenshots, 'zh-dark-menu.png') })
    await chinese.getByRole('menuitem').first().click()
    await chinese.getByRole('dialog', { name: '会话信箱', exact: true }).screenshot({ path: join(screenshots, 'zh-dark-dialog.png') })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
  }
})
