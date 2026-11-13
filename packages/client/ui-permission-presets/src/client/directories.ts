/** Session-scoped directory resources and cancellable owner command transport. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RootApprovalPreview, SessionRootRequest } from '@deepseek-ai/dsh-sandbox-policy/types'
import type { SessionRootsState } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Fresh owner-authorized directory facts for one exact Host Session. */
    'session-directories': SessionRootsState
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A cached directory fact is invalid and must not be shown as active authority. */
    'directories/refreshing': {}
    /** The directory resource transport could not retrieve current facts. */
    'directories/unavailable': {}
  }
}

/**
 * Address the directory state for one Session.
 * @param sessionId - the encoded Session identity.
 * @returns its resource URL.
 */
export function directoryAddress(sessionId: SessionId): string {
  return `dsh-resource://session-directories/${encodeURIComponent(sessionId)}`
}

/** The resource registry owns snapshots; this adapter owns only request lifetimes and invalidations. */
export class DirectoryCommands {
  /** Increments when a connection replacement ends local interactions. */
  readonly connection = createSnapshotStore(0)
  /** Increments when directory previews must be refreshed. */
  readonly changes = createSnapshotStore(0)
  private readonly sessionLifetimes = new Map<SessionId, SnapshotStore<number>>()
  private readonly pending = new Map<SessionId, AbortController>()
  private lifetime = new AbortController()
  private readonly listeners = new Map<SessionId, Set<() => void>>()

  constructor(private readonly remote: Pick<Context['remote']['session'], 'roots' | 'replaceRoots' | 'prepareRoots' | 'confirmRoots' | 'cancelRoots'>) {}

  /**
   * Observe the local interaction lifetime for a Session.
   * @param sessionId - target Session.
   * @returns the source that changes when its binding is replaced.
   */
  lifetimeOf(sessionId: SessionId): SnapshotStore<number> {
    let source = this.sessionLifetimes.get(sessionId)
    if (source === undefined) {
      source = createSnapshotStore(0)
      this.sessionLifetimes.set(sessionId, source)
    }
    return source
  }

  /**
   * End edits and requests for a replaced Session binding.
   * @param sessionId - target Session.
   */
  replaceLifetime(sessionId: SessionId): void {
    this.abort(sessionId)
    const source = this.lifetimeOf(sessionId)
    source.set(source.getSnapshot() + 1)
    this.invalidate(sessionId)
  }

  /**
   * Refresh the resource after a directory change.
   * @param sessionId - target Session, or all Sessions when omitted.
   */
  invalidate(sessionId?: SessionId): void {
    this.changes.set(this.changes.getSnapshot() + 1)
    if (sessionId !== undefined) {
      for (const listener of this.listeners.get(sessionId) ?? []) listener()
    } else {
      for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
    }
  }

  /** Abort old calls before exposing the new connection generation. */
  reset(): void {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.connection.set(this.connection.getSnapshot() + 1)
    this.invalidate()
  }

  /** Abort outstanding requests on plugin disposal. */
  dispose(): void { this.lifetime.abort(); this.invalidate() }

  /**
   * Cancel the pending request for this Session.
   * @param sessionId - Session whose pending command should stop.
   */
  abort(sessionId: SessionId): void { this.pending.get(sessionId)?.abort() }

  /**
   * Save a revision-bound directory selection.
   * @param sessionId - target Session.
   * @param roots - replacement directories.
   * @param expectedRevision - observed revision, or null.
   */
  async replace(sessionId: SessionId, roots: readonly SessionRootRequest[], expectedRevision: number | null): Promise<void> {
    await this.command(sessionId, signal => this.remote.replaceRoots({ sessionId, roots, expectedRevision }, signal))
  }

  /**
   * Ask the Host to preview the saved selection.
   * @param sessionId - active Session.
   * @returns the one-use confirmation preview.
   */
  prepare(sessionId: SessionId): Promise<RootApprovalPreview> {
    return this.command(sessionId, signal => this.remote.prepareRoots({ sessionId }, signal), false)
  }

  /**
   * Confirm the current preview and refresh the Session resource.
   * @param sessionId - active Session.
   * @param nonce - current Peer's preview nonce.
   */
  async confirm(sessionId: SessionId, nonce: string): Promise<void> {
    await this.command(sessionId, signal => this.remote.confirmRoots({ sessionId, nonce }, signal))
  }

  /**
   * Discard the preview held by the current Peer.
   * @param sessionId - active Session.
   * @param nonce - preview nonce to discard.
   */
  async cancel(sessionId: SessionId, nonce: string): Promise<void> {
    const result = await this.remote.cancelRoots({ sessionId, nonce }, this.lifetime.signal)
    if (!result.ok) throw new Error(result.error.message)
  }

  private async command<T>(sessionId: SessionId, run: (signal: AbortSignal) => Promise<RemoteResult<T>>, refresh = true): Promise<T> {
    this.abort(sessionId)
    const operation = new AbortController()
    this.pending.set(sessionId, operation)
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal])
    try {
      const result = await run(signal)
      signal.throwIfAborted()
      if (refresh) this.invalidate(sessionId)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    } finally {
      if (this.pending.get(sessionId) === operation) this.pending.delete(sessionId)
    }
  }

  /** Scoped resource that publishes fresh directory state on invalidation. */
  readonly provider: ResourceProvider<'session-directories'> = {
    protocol: 'session-directories',
    open: (address, options) => this.open(address, options.signal),
  }

  private async *open(address: string, signal: AbortSignal): AsyncIterable<RemoteResult<SessionRootsState>> {
    const sessionId = decodeURIComponent(new URL(address).pathname.slice(1)) as SessionId
    let revision = 0
    let dirty = true
    let first = true
    let wake = Promise.withResolvers<void>()
    let request: AbortController | undefined
    const changed = (): void => { ++revision; dirty = true; request?.abort(); wake.resolve() }
    const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
    this.listeners.set(sessionId, listeners)
    listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    const isStopped = (): boolean => signal.aborted
    try {
      while (!isStopped()) {
        if (!dirty) { await wake.promise; wake = Promise.withResolvers<void>(); continue }
        dirty = false
        const observed = revision
        if (!first) yield { ok: false, error: new RemoteError('directories/refreshing', 'Refreshing directory permissions', {}) }
        first = false
        request = new AbortController()
        const requestSignal = AbortSignal.any([signal, this.lifetime.signal, request.signal])
        let result: RemoteResult<SessionRootsState>
        try {
          result = await this.remote.roots({ sessionId }, requestSignal)
        } catch (error) {
          if (isStopped()) return
          if (observed !== revision || requestSignal.aborted) continue
          result = { ok: false, error: new RemoteError('directories/unavailable', error instanceof Error ? error.message : String(error), {}) }
        }
        // A late response from an invalidated selection or connection never republishes authority.
        if (isStopped()) return
        if (observed !== revision || requestSignal.aborted) continue
        yield result
      }
    } finally {
      request?.abort()
      signal.removeEventListener('abort', changed)
      listeners.delete(changed)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }
}
