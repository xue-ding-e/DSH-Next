/** Next-only terminal bootstrap; resolve isolated data before loading the shared CLI. */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nextDesktopDistribution } from './next-distribution.ts'
import { nextDesktopEnvironment, nextDesktopInstallRoot } from './next-profile.ts'

const application = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest: unknown = JSON.parse(await readFile(join(application, 'package.json'), 'utf8'))
if (nextDesktopDistribution(manifest) === undefined) throw new Error('Next CLI: a marked Next desktop package is required')
Object.assign(process.env, await nextDesktopEnvironment(homedir(), process.env, nextDesktopInstallRoot(process.execPath, process.platform)))
const entry = join(application, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
process.argv[1] = entry
const cli: { runDesktopCliEntry: () => Promise<void> } = await import(pathToFileURL(entry).href)
await cli.runDesktopCliEntry()
