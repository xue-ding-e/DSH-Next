/** Locale-owned native command-management states. */

import { expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { commandMessages, presentCommandManagement } from '../src/command-management.ts'

it.each([en, zh])('shows installation, repair/removal and shadowed command locations', (messages) => {
  const destination = '/usr/local/bin/dsh'
  const missing = presentCommandManagement({ managed: false, available: false, destination }, messages, 'darwin')
  expect(missing.buttons).toEqual([messages.cliCommandInstall, messages.cancel])
  expect(missing.cancelId).toBe(1)
  const installed = presentCommandManagement({ managed: true, available: true, destination, activeCommand: destination }, messages, 'darwin')
  expect(installed.buttons).toEqual([messages.cliCommandClose, messages.cliCommandRepair, messages.cliCommandRemove])
  expect(installed.cancelId).toBe(0)
  const shadowed = presentCommandManagement({ managed: true, available: true, destination, activeCommand: '/opt/homebrew/bin/dsh' }, messages, 'darwin')
  expect(shadowed.type).toBe('warning')
  expect(shadowed.detail).toContain('/opt/homebrew/bin/dsh')
  expect(shadowed.detail).toContain(messages.cliCommandShadowed)
  const unknown = presentCommandManagement({ managed: false, available: false, destination, selectionUnknown: true }, messages, 'darwin')
  expect(unknown.detail).toContain(messages.cliCommandSelectionUnknown)
})

it.each([
  ['darwin', 'en-US', en], ['darwin', 'zh-CN', zh],
  ['win32', 'en-US', en], ['win32', 'zh-CN', zh],
] as const)('records command status on %s in %s', async (platform, language, messages) => {
  const destination = platform === 'darwin' ? '/usr/local/bin/dsh' : 'C:\\Users\\user\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
  const other = platform === 'darwin' ? '/opt/homebrew/bin/dsh' : 'C:\\Program Files\\nodejs\\dsh.cmd'
  const states = [
    { managed: false, available: false, destination },
    { managed: true, available: true, destination, activeCommand: destination },
    { managed: true, available: false, destination },
    { managed: true, available: true, destination, activeCommand: other },
    { managed: false, available: false, destination, selectionUnknown: true },
  ]
  await expect(JSON.stringify({
    dialogs: states.map(state => presentCommandManagement(state, messages, platform)),
  }, null, 2) + '\n').toMatchFileSnapshot(`./expected/command-management-${platform}-${language}.json`)
})

it.each([['en-US', en], ['zh-CN', zh]] as const)('uses the separate Next command in locale-owned labels in %s', async (language, messages) => {
  expect(commandMessages(messages)).toBe(messages)
  const next = commandMessages(messages, 'next')
  const command = Object.fromEntries(Object.entries(next).filter(([key]) => key.startsWith('cliCommand')))
  await expect(JSON.stringify(command, null, 2) + '\n').toMatchFileSnapshot(`./expected/command-next-${language}.json`)
  for (const key of Object.keys(messages) as Array<keyof typeof messages>) {
    if (!key.startsWith('cliCommand')) expect(next[key]).toBe(messages[key])
  }
})
