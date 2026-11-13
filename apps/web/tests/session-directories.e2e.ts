/** Exercise additional directory settings in the assembled Web client and Host. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('confirms a reference directory for one Session and leaves new Session defaults pending', async () => {
  const host = await launchWebScaffold({ profile: { hmr: false, packages: [] } })
  onTestFinished(() => host.close())
  const primary = join(host.workspaceCwd, 'primary')
  const reference = join(host.workspaceCwd, 'reference')
  await mkdir(primary)
  await mkdir(reference)
  const workspace = await host.ctx.workspaceRegistry.create(primary)
  const seed = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
  const original = await seedSession({ ...host, workspaceCwd: primary }, seed, 'directory-ui-existing')
  await workspace.attachSession(original)
  await host.ctx.sessionController.rename({ sessionId: original, title: 'Directory settings' })
  await workspace.setAdditionalRoots([{ path: reference, access: 'reference' }])
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    await page.goto(host.authenticatedUrl)
    await page.getByRole('region', { name: 'Recent', exact: true }).getByRole('button', { name: 'Directory settings', exact: true }).click()
    await page.getByRole('button', { name: 'Manage directories' }).click()
    const dialog = page.getByRole('dialog', { name: 'Session directories' })
    await dialog.getByText(/Primary directory/).waitFor()
    expect(await dialog.getByRole('button', { name: 'Preview confirmation' }).isDisabled()).toBe(true)
    await dialog.getByRole('button', { name: 'New-session defaults' }).click()
    await dialog.getByRole('combobox', { name: reference }).waitFor()
    await dialog.getByRole('button', { name: 'This session' }).click()
    await dialog.getByRole('button', { name: 'Add directory' }).click()
    const chooser = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await chooser.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = chooser.locator('input[aria-label="Edit path"]')
    await pathInput.fill(reference)
    await page.keyboard.press('Enter')
    await pathInput.waitFor({ state: 'detached' })
    await chooser.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.getByRole('combobox', { name: reference }).waitFor()
    await dialog.getByRole('button', { name: 'Save selection' }).click()
    const preview = dialog.getByRole('button', { name: 'Preview confirmation' })
    await expect.poll(async () => ({ enabled: await preview.isEnabled(), alerts: await dialog.getByRole('alert').allTextContents() }))
      .toEqual({ enabled: true, alerts: [] })
    await preview.click()
    await dialog.getByRole('checkbox', { name: /reviewed these exact directories/ }).check()
    await dialog.getByRole('button', { name: 'Confirm selected directories' }).click()
    await expect.poll(() => {
      const agent = host.ctx.agents.get(original)
      return agent?.ctx.get('sandboxPolicy')?.confirmedRootsOf(agent.session)
    }).toEqual([{ path: reference, access: 'reference' }])
    const created = await host.ctx.sessionController.create({ workspaceId: workspace.id })
    const agent = host.ctx.agents.get(created.sessionId)
    expect(agent?.session.header.cwd).toBe(primary)
    expect(agent?.session.snapshotEvents().find(event => event.type === 'sandbox/roots-requested')?.data)
      .toEqual({ roots: [{ path: reference, access: 'reference' }] })
    expect(agent?.ctx.get('sandboxPolicy')?.confirmedRootsOf(agent.session)).toEqual([])
    expect(console.pageErrors).toEqual([])
  } finally {
    await browser.close()
  }
})
