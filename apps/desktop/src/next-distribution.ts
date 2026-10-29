/** Identity and data ownership for the separately installed Next desktop distribution. */

/** Public identifiers owned by this recreated repository, separate from upstream installations. */
export const NEXT_DESKTOP_IDENTITY = {
  appId: 'io.github.xue-ding-e.dsh-next',
  installerGuid: 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a',
  packageName: 'dsh-next-desktop',
  productName: 'DSH Next',
  protocol: 'dsh-next',
  homeDirectory: '.dsh-next',
  repository: 'xue-ding-e/DSH-Next',
  repositoryId: 1437727533,
} as const

/** Packaged Next updates are manual until a separately validated signing configuration exists. */
export interface NextDesktopDistribution {
  readonly updateMode: 'manual'
  readonly channel: 'latest' | 'nightly'
}

/**
 * Read an explicit Next marker without interpreting old installation paths as package identity.
 * @param manifest Parsed packaged application metadata; an absent marker keeps upstream behavior.
 * @returns Next settings, or undefined for unmarked upstream/development packages.
 */
export function nextDesktopDistribution(manifest: unknown): NextDesktopDistribution | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const marked = 'dshNext' in manifest || ('name' in manifest && manifest.name === NEXT_DESKTOP_IDENTITY.packageName)
    || ('dshDesktopAppId' in manifest && manifest.dshDesktopAppId === NEXT_DESKTOP_IDENTITY.appId)
    || ('productName' in manifest && manifest.productName === NEXT_DESKTOP_IDENTITY.productName)
  if (!marked) return undefined
  const next = 'dshNext' in manifest ? manifest.dshNext : undefined
  if (typeof next !== 'object' || next === null
    || !('schemaVersion' in next) || next.schemaVersion !== 1
    || !('repositoryId' in next) || next.repositoryId !== NEXT_DESKTOP_IDENTITY.repositoryId
    || !('repository' in next) || next.repository !== NEXT_DESKTOP_IDENTITY.repository
    || !('updateMode' in next) || next.updateMode !== 'manual'
    || !('productName' in manifest) || manifest.productName !== NEXT_DESKTOP_IDENTITY.productName
    || !('name' in manifest) || manifest.name !== NEXT_DESKTOP_IDENTITY.packageName
    || !('dshDesktopAppId' in manifest) || manifest.dshDesktopAppId !== NEXT_DESKTOP_IDENTITY.appId
    || ('dshMandatoryUpdatePolicy' in manifest && manifest.dshMandatoryUpdatePolicy !== undefined)
    || !('dshDesktopUpdateChannel' in manifest)
    || (manifest.dshDesktopUpdateChannel !== 'nightly' && manifest.dshDesktopUpdateChannel !== 'latest')) {
    throw new Error('Next desktop: packaged distribution identity is invalid')
  }
  return { updateMode: 'manual', channel: manifest.dshDesktopUpdateChannel }
}
