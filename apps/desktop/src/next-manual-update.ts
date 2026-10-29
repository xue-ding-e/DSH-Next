/** Public release checks for unsigned Next packages; never downloads or executes an installer. */
import { gt, prerelease, valid } from 'semver'
import type { DesktopUpdateState } from './ipc.ts'
import { NEXT_DESKTOP_IDENTITY } from './next-distribution.ts'

/** Missing releases and missing target installers differ from network or access failures. */
export type NextManualUpdateResult =
  | { readonly kind: 'unqueried' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'current' }
  | { readonly kind: 'available'; readonly version: string; readonly page: string }
  | { readonly kind: 'error'; readonly reason: 'network' | 'access' | 'identity' | 'response' }

const API = `https://api.github.com/repos/${NEXT_DESKTOP_IDENTITY.repository}`
const WEB = `https://github.com/${NEXT_DESKTOP_IDENTITY.repository}`

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Select an uploaded installer only from a version-named Next release in the requested channel.
 * @param releases Public GitHub release JSON; never release descriptions or executable content.
 * @param channel Installed channel.
 * @param currentVersion Installed application version; newer versions only, never downgrades.
 * @param platform Native package platform.
 * @param arch Native package architecture.
 * @returns A validated public release page, current, or unavailable; no installer is executed.
 */
export function selectNextManualRelease(releases: unknown, channel: 'latest' | 'nightly', currentVersion: string,
  platform: string, arch: string): NextManualUpdateResult {
  if (!Array.isArray(releases) || valid(currentVersion) !== currentVersion) return { kind: 'error', reason: 'response' }
  if (!(platform === 'win32' && arch === 'x64') && !(platform === 'darwin' && ['x64', 'arm64'].includes(arch))) {
    return { kind: 'unavailable' }
  }
  let selected: { version: string; page: string } | undefined
  let compatible = false
  for (const release of releases) {
    if (!record(release) || release.draft !== false || release.prerelease !== (channel === 'nightly')
      || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('next-v') || !Array.isArray(release.assets)) continue
    const version = release.tag_name.slice('next-v'.length)
    if (valid(version) !== version || version.includes('+') || (prerelease(version) !== null) !== release.prerelease) continue
    const page = `${WEB}/releases/tag/${encodeURIComponent(release.tag_name)}`
    if (release.html_url !== page) continue
    const os = platform === 'win32' ? 'win' : 'mac'
    const extension = platform === 'win32' ? 'exe' : 'dmg'
    const filename = `dsh-next-${version}-${os}-${arch}-unsigned.${extension}`
    const expectedUrl = `${WEB}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(filename)}`
    const asset = release.assets.find((value: unknown) => record(value) && value.name === filename
      && value.state === 'uploaded' && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size > 0
      && value.browser_download_url === expectedUrl)
    if (asset === undefined) continue
    compatible = true
    if (gt(version, currentVersion) && (selected === undefined || gt(version, selected.version))) selected = { version, page }
  }
  return selected === undefined ? { kind: compatible ? 'current' : 'unavailable' } : { kind: 'available', ...selected }
}

/**
 * Recheck repository identity and inspect public releases without cookies, tokens, or redirects.
 * @param channel Installed Next channel.
 * @param currentVersion Installed version.
 * @param platform Native package platform.
 * @param arch Native package architecture.
 * @param request HTTP transport; defaults to anonymous fetch and is replaceable in tests.
 * @returns A structured result without raw response diagnostics or private request data.
 */
export async function checkNextManualRelease(channel: 'latest' | 'nightly', currentVersion: string,
  platform: string, arch: string, request: typeof fetch = fetch): Promise<NextManualUpdateResult> {
  const json = async (response: Response): Promise<{ value: unknown } | undefined> => {
    const text = await response.text()
    if (text.length > 2_000_000) return undefined
    try { return { value: JSON.parse(text) } }
    catch (_error) { return undefined /* Invalid public JSON is a response failure, not an authentication diagnosis. */ }
  }
  try {
    const signal = AbortSignal.timeout(15_000)
    const get = async (url: string): Promise<Response> => request(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DSH-Next-update-check' },
      credentials: 'omit', redirect: 'error', signal,
    })
    const identity = await get(API)
    if (identity.status === 401 || identity.status === 403) return { kind: 'error', reason: 'access' }
    if (!identity.ok) return { kind: 'error', reason: 'identity' }
    const identityBody = await json(identity)
    const repository = identityBody?.value
    if (!record(repository) || repository.id !== NEXT_DESKTOP_IDENTITY.repositoryId
      || repository.full_name !== NEXT_DESKTOP_IDENTITY.repository || repository.private !== false) {
      return { kind: 'error', reason: 'identity' }
    }
    const releases: unknown[] = []
    let url = `${API}/releases?per_page=100`
    // Bounded traversal cannot silently turn an incomplete listing into "current" or "unavailable".
    for (let page = 1; page <= 10; page++) {
      const response = await get(url)
      if (response.status === 404) return page === 1 ? { kind: 'unavailable' } : { kind: 'error', reason: 'response' }
      if (response.status === 401 || response.status === 403) return { kind: 'error', reason: 'access' }
      if (!response.ok) return { kind: 'error', reason: 'response' }
      const body = await json(response)
      if (body === undefined || !Array.isArray(body.value) || body.value.length > 100) return { kind: 'error', reason: 'response' }
      releases.push(...body.value)
      const next = response.headers.get('link')?.split(',').find(link => /;\s*rel="next"/u.test(link))
      if (next === undefined) return selectNextManualRelease(releases, channel, currentVersion, platform, arch)
      const linked = /^\s*<([^>]+)>;\s*rel="next"\s*$/u.exec(next)?.[1]
      // The API may order its query parameters differently; no arbitrary Link target is requested.
      const expected = new URL(`${API}/releases?per_page=100&page=${String(page + 1)}`)
      if (linked === undefined) return { kind: 'error', reason: 'response' }
      const actual = new URL(linked)
      actual.searchParams.sort(); expected.searchParams.sort()
      if (actual.href !== expected.href) return { kind: 'error', reason: 'response' }
      url = linked
    }
    return { kind: 'error', reason: 'response' }
  } catch (_error) {
    // Raw fetch/parser errors can include request data; only the bounded category reaches the UI.
    return { kind: 'error', reason: 'network' }
  }
}

/** Owns only anonymous release discovery; opening a download page remains a separate user action. */
export class NextManualUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle' }
  private checked: NextManualUpdateResult = { kind: 'unqueried' }
  private operation: Promise<DesktopUpdateState> | undefined
  private disposed = false

  /**
   * @param publish Desktop-owned observable update state.
   * @param lookup Anonymous release check, replaceable with a synthetic transport in tests.
   */
  constructor(private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly lookup: () => Promise<NextManualUpdateResult>) {}

  /** Latest state; a missing published installer is not reported as a missing credential. */
  get state(): DesktopUpdateState { return this.current }
  /** The discovery result distinguishes an empty channel from an installed current version. */
  get result(): NextManualUpdateResult { return this.checked }

  /**
   * Join one read-only release lookup; never start a download or installation.
   * @returns Observable result after the shared lookup settles.
   */
  async check(): Promise<DesktopUpdateState> {
    if (this.disposed) throw new Error('Next update check is disposed')
    this.operation ??= this.lookup().then(result => {
      if (this.disposed) return this.current
      this.checked = result
      this.current = this.publish(result.kind === 'available' ? { phase: 'available', version: result.version }
        : result.kind === 'error' ? { phase: 'error', failedOperation: 'check', message: `Next update check: ${result.reason}` }
          : { phase: 'idle' })
      return this.current
    }).finally(() => { this.operation = undefined })
    return this.operation
  }

  /** Stop observing late responses; no installation or process shutdown is owned by this coordinator. */
  dispose(): void { this.disposed = true }
}
