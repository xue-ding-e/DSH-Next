/** Feed fields the Next release configuration owns. */
export interface NextAppUpdateFeed {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly channel: string
  readonly releaseType: string
}

/**
 * Resolve the GitHub provider and channel the Next distribution publishes through.
 * @param publish Final electron-builder publish setting.
 * @returns Feed fields owned by the release configuration.
 */
export function resolveNextAppUpdateFeed(publish: unknown): NextAppUpdateFeed

/**
 * Ensure an assembled Next application carries the GitHub release feed.
 * @param resourcesDir Assembled application resources directory.
 * @param publish Final electron-builder publish setting.
 * @param updaterCacheDirName electron-builder application cache directory for this package.
 * @returns Whether this call created the configuration.
 */
export function ensureNextAppUpdateConfig(
  resourcesDir: string,
  publish: unknown,
  updaterCacheDirName: string,
): Promise<'written' | 'present'>

/**
 * Verify that an assembled Next application carries the exact GitHub release feed.
 * @param resourcesDir Assembled application resources directory.
 * @param publish Final electron-builder publish setting.
 * @param updaterCacheDirName electron-builder application cache directory for this package.
 */
export function verifyNextAppUpdateConfig(
  resourcesDir: string,
  publish: unknown,
  updaterCacheDirName: string,
): Promise<void>
