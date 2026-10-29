/** Package terminal launch scripts that reuse the installed Electron runtime. */

import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { desktopCommandIdentity, type DesktopCommandDistribution } from '../src/command-identity.ts'

/**
 * Copy the platform launcher into the application's public command directory.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param platform - Target Desktop operating system.
 * @param distribution - Explicit package identity; omission preserves the official launcher.
 */
export function prepareDesktopCli(destination: string, platform: 'darwin' | 'win32', distribution: DesktopCommandDistribution = 'official'): void {
  const identity = desktopCommandIdentity(distribution)
  const name = platform === 'win32' ? identity.windowsName : identity.name
  const command = join(destination, 'bin', name)
  mkdirSync(join(destination, 'bin'), { recursive: true })
  copyFileSync(join(import.meta.dirname, '..', 'cli', name), command)
  if (platform === 'darwin') chmodSync(command, 0o755)
}
