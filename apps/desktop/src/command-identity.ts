/** Command names and ownership records for explicit Desktop distributions. */

/** Selected by packaged metadata; an omitted option retains official command behavior. */
export type DesktopCommandDistribution = 'official' | 'next'

/**
 * Resolve fixed names without inferring product identity from an installation path.
 * @param distribution - Explicit package distribution; omission selects the official command.
 * @returns Names used by launchers, receipts, and command lookup.
 */
export function desktopCommandIdentity(distribution: DesktopCommandDistribution = 'official') {
  const name = distribution === 'next' ? 'dsh-next' : 'dsh'
  return {
    name,
    windowsName: `${name}.cmd`,
    receiptName: `.${name}-desktop-command.json`,
    backupPrefix: `.${name}-command-backup-`,
    pendingPrefix: `.${name}-command-new-`,
  }
}
