/** Resolve a separately owned Next data root before either Desktop or CLI accesses a profile. */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep, dirname } from 'node:path'
import { canonicalizeWatchPath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { NEXT_DESKTOP_IDENTITY } from './next-distribution.ts'

/**
 * Resolve the Next-only data root; no existing upstream data is read, copied, or modified.
 * @param userHome Operating-system user home.
 * @param configured Explicit DSH_NEXT_HOME; absent or blank selects the separate default root.
 * @returns Absolute Next data root, rejecting the upstream home and filesystem root.
 */
export function nextDesktopHome(userHome: string, configured?: string): string {
  const value = configured?.trim()
  if (value && !isAbsolute(value)) throw new Error('Next desktop: DSH_NEXT_HOME must be absolute')
  const target = resolve(value || join(userHome, NEXT_DESKTOP_IDENTITY.homeDirectory))
  const upstream = resolve(userHome, '.dsh')
  const withinUpstream = relative(upstream, target)
  if (target === parse(target).root || withinUpstream === ''
    || (withinUpstream !== '..' && !withinUpstream.startsWith(`..${sep}`) && !isAbsolute(withinUpstream))) {
    throw new Error('Next desktop: use a separate data directory, not the upstream Harness home')
  }
  return target
}

/** Reject unresolved link ancestors instead of treating their target as an ordinary missing suffix. */
async function canonicalDataRoot(path: string): Promise<string> {
  let ancestor = resolve(path)
  while (true) {
    let linked = false
    try { linked = (await lstat(ancestor)).isSymbolicLink() }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
      continue
    }
    if (linked) {
      try { await realpath(ancestor) }
      catch (_error) { throw new Error('Next desktop: a separate data directory requires resolvable link ancestors') }
    }
    return canonicalizeWatchPath(path)
  }
}

/**
 * Canonicalize existing ancestors before choosing a data root, including Windows junctions.
 * No profile contents are read or copied. Ancestors of an official root are protected too.
 * @param userHome Operating-system home.
 * @param configured Explicit DSH_NEXT_HOME.
 * @param upstreamHome Inherited upstream DSH_HOME, before the caller maps the Next child environment.
 * @param installationRoot Actual application installation, which replacement or uninstall removes.
 * @returns Separate canonical Next root, including a not-yet-created suffix.
 */
export async function resolveNextDesktopHome(userHome: string, configured?: string, upstreamHome?: string, installationRoot?: string): Promise<string> {
  const target = await canonicalDataRoot(nextDesktopHome(userHome, configured))
  const protectedRoots = [join(userHome, '.dsh')]
  if (installationRoot !== undefined) protectedRoots.push(installationRoot)
  if (upstreamHome?.trim()) protectedRoots.push(resolve(expandHomePath(upstreamHome)))
  const contains = (parent: string, child: string): boolean => {
    const suffix = relative(parent, child)
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  }
  for (const root of protectedRoots) {
    const upstream = await canonicalDataRoot(root)
    if (contains(upstream, target) || contains(target, upstream)) {
      throw new Error('Next desktop: use a separate data directory, not the upstream Harness home')
    }
  }
  return target
}

/**
 * Map only a verified Next process to its own root, preserving the original upstream root in children.
 * Internal markers let a nested dsh-next command retain the same protection without mistaking its
 * parent's mapped DSH_HOME for an upstream configuration. They never establish product identity.
 * @param userHome Operating-system home.
 * @param environment Parent environment, not modified.
 * @param installationRoot Actual application installation directory.
 * @returns Child environment with a canonical separate home and original upstream ownership.
 */
export async function nextDesktopEnvironment(userHome: string, environment: NodeJS.ProcessEnv, installationRoot?: string): Promise<NodeJS.ProcessEnv> {
  const inheritedNext = environment.DSH_NEXT_ACTIVE_HOME !== undefined
    && environment.DSH_HOME === environment.DSH_NEXT_ACTIVE_HOME
    && environment.DSH_NEXT_UPSTREAM_HOME !== undefined
  const upstream = (inheritedNext ? environment.DSH_NEXT_UPSTREAM_HOME : environment.DSH_HOME)?.trim()
    || join(userHome, '.dsh')
  const root = await resolveNextDesktopHome(userHome, environment.DSH_NEXT_HOME, upstream, installationRoot)
  return { ...environment, DSH_HOME: root, DSH_NEXT_ACTIVE_HOME: root, DSH_NEXT_UPSTREAM_HOME: upstream }
}

/**
 * Resolve the actual package root, never guessing identity from an old installation folder.
 * @param executable Installed Electron executable path.
 * @param platform Runtime platform.
 * @returns Directory the native installer may replace or delete.
 */
export function nextDesktopInstallRoot(executable: string, platform: string): string {
  return platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable)
}
