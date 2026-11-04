/** Channel policy applied after electron-updater's channel setter. */
import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateChannel } from '../../update-channel.ts'

/**
 * Select an operator-managed or GitHub version channel while preventing downgrades.
 * Official nightly/stable feeds accept prereleases; GitHub latest remains stable-only.
 * @param updater - Updater whose prior operations have settled.
 * @param channel - Selected distribution channel.
 */
export function selectUpdateChannel(updater: AppUpdater, channel: DesktopUpdateChannel): void {
  updater.channel = channel
  // The library channel setter enables downgrades.
  updater.allowDowngrade = false
  updater.allowPrerelease = channel !== 'latest'
}
