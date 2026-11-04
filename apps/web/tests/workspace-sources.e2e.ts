/** Exercises saved source directories through the shipped browser and Host services. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

it('saves source folders, changes the primary directory and restores them after reload', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  try {
    const secondary = join(scaffold.workspaceCwd, 'secondary')
    await mkdir(secondary)
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'primary')
    const primary = await scaffold.ctx.workspaceRegistry.resolveByPath(join(scaffold.workspaceCwd, 'primary'))
    if (primary === undefined) throw new Error('Workspace was not adopted')
    const row = page.locator(`[data-row-key="workspace:${primary.id}"]`)
    await row.hover()
    await row.getByRole('button', { name: 'Workspace actions for primary', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Edit workspace', exact: true })
    await editor.getByRole('button', { name: 'Add folder', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
    await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
    await picker.getByRole('textbox', { name: 'Edit path', exact: true }).fill(secondary)
    await page.keyboard.press('Enter')
    await picker.getByRole('button', { name: 'Open', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    await editor.getByRole('button', { name: 'Make primary', exact: true }).click()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await expect.poll(() => primary.sourcePaths).toEqual([secondary, primary.path])
    const originalAgent = scaffold.ctx.agents.list().find(agent => agent.session.header.cwd === primary.path)
    if (originalAgent === undefined) throw new Error('Original Workspace Session disappeared')
    expect(scaffold.ctx.sandboxPolicy.resolve({ session: originalAgent.session })).toMatchObject({
      mode: 'workspace-write', workspaceRoot: primary.path, additionalWritableRoots: [secondary],
    })
    const previousIds = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
    await row.hover()
    await row.getByRole('button', { name: 'New session in primary', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agents.list()
      .find(agent => !previousIds.has(agent.id))?.session.header.cwd).toBe(secondary)
    const created = scaffold.ctx.agents.list().find(agent => !previousIds.has(agent.id))
    if (created === undefined) throw new Error('New primary-directory Session disappeared')
    await expect.poll(() => primary.sessionIds.includes(created.id)).toBe(true)
    expect(scaffold.ctx.sandboxPolicy.resolve({ session: created.session })).toMatchObject({
      mode: 'workspace-write', workspaceRoot: secondary, additionalWritableRoots: [primary.path],
    })
    const warningStart = tripwire.warnings.length
    await page.reload()
    await row.waitFor()
    await row.hover()
    await row.getByRole('button', { name: 'Workspace actions for primary', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await editor.getByTitle(secondary, { exact: true }).waitFor()
    await editor.getByTitle(secondary, { exact: true }).locator('..').getByText('Primary', { exact: true }).waitFor()
    expect(await editor.getByText('Primary', { exact: true }).count()).toBe(1)
    const evidence = join(REPO_ROOT, '.playwright-mcp', 'desktop-interactions')
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'workspace-edit.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(evidence, 'workspace-edit-narrow.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    const lightBackground = await editor.evaluate(element => getComputedStyle(element).backgroundColor)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => editor.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(lightBackground)
    await page.screenshot({ path: join(evidence, 'workspace-edit-dark.png'), animations: 'disabled' })
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
})
