/** Resolve the update channel sealed into the installed application manifest. */

/**
 * Installed feed name: official packages use nightly/stable; Next uses its version's channel.
 * The GitHub provider matches a prerelease's first field, while official feeds accept either version kind.
 */
export type DesktopUpdateChannel = string

/**
 * Read the first prerelease field of a version, or undefined for a stable one.
 *
 * The CLI entry bundles this module and imports only `node:` builtins, so it must not pull in
 * a version parser. Build metadata and the release triple are skipped the same way semver does.
 * @param version Version to read.
 * @returns The first prerelease identifier, or undefined.
 */
function firstPrereleaseField(version: string): string | undefined {
  const withoutBuild = version.split('+')[0] ?? ''
  const separator = withoutBuild.indexOf('-')
  if (separator < 0) return undefined
  const [field] = withoutBuild.slice(separator + 1).split('.')
  return field === undefined || field === '' ? undefined : field
}

/**
 * Read the packaged channel; older manifests retain their existing nightly behavior.
 *
 * Next must name its packaged version's first prerelease field, or latest for a stable version.
 * Official nightly/stable feeds are independent of the packaged version.
 * @param manifest Parsed application manifest.
 * @returns Validated channel. Invalid explicit values reject instead of changing feeds.
 */
export function desktopUpdateChannel(manifest: unknown): DesktopUpdateChannel {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpdateChannel' in manifest)) return 'nightly'
  const channel = manifest.dshDesktopUpdateChannel
  if (typeof channel !== 'string') throw new Error('desktop update: invalid packaged channel')
  if ('dshNext' in manifest) {
    const version = 'version' in manifest ? manifest.version : undefined
    if (typeof version !== 'string' || (firstPrereleaseField(version) ?? 'latest') !== channel) {
      throw new Error('desktop update: Next channel must match the packaged version')
    }
    return channel
  }
  if (channel === 'nightly' || channel === 'stable') return channel
  // A custom channel must be the prerelease field of the packaged version; anything else
  // would request a feed that no release of this version can ever satisfy.
  const version = 'version' in manifest ? manifest.version : undefined
  if (typeof version !== 'string' || firstPrereleaseField(version) !== channel) {
    throw new Error('desktop update: invalid packaged channel')
  }
  return channel
}
