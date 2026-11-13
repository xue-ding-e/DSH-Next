/** Session Controller adapter for Agent-scoped file-reference discovery. */

import { isAbsolute, normalize, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-file-reference'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `fileReferences` Remote namespace. */
    sessionFileReferences: SessionFileReferences
  }
}

/** Host Remote adapter over the composed file-reference provider. */
export class SessionFileReferences extends TypertRemoteService {
  static inject = ['fileReferences', 'typert']

  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' })
  }

  /**
   * Resolve a path-only drag through both Sessions' current file discovery scopes.
   * No file bytes are read, uploaded, or granted additional tool access.
   * @param agent - destination Agent authorized by the Gateway.
   * @param sourceSessionId - origin identity, authorized before its Agent lookup.
   * @param path - absolute source path; never rebound relative to the destination.
   * @param kind - expected entry kind from the source listing.
   * @param signal - cancellation before any result is staged by the caller.
   * @returns one current path-only candidate; later reads remain normal tool operations.
   */
  @Remote
  async resolveDrop(
    agent: Agent,
    sourceSessionId: SessionId,
    path: string,
    kind: 'file' | 'directory',
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate> {
    const unavailable = (): RemoteError => new RemoteError('file-reference/unavailable', 'File reference is unavailable.', {})
    const principal = principalOf(this.ctx.invocation)
    const scopeChecks: Array<() => boolean> = []
    const check = (): void => {
      signal.throwIfAborted()
      this.ctx.invocation?.peer.signal.throwIfAborted()
      if (principal !== undefined) {
        const access = this.ctx.get('remoteAccess')
        const grants = [
          { id: sourceSessionId, action: 'fileReferences/list' as const },
          { id: agent.id, action: 'fileReferences/list' as const },
          { id: agent.id, action: 'session/prompt' as const },
          { id: agent.id, action: 'fileReferences/resolveDrop' as const },
        ]
        if (access === undefined || grants.some(({ id, action }) =>
          access.decide({ principal, action, resources: [{ kind: 'session', id }] }).kind !== 'allow')) throw unavailable()
      }
      // No provider metadata is inspected after a known resource denial.
      try { if (scopeChecks.some(valid => !valid())) throw unavailable() }
      catch (_error) {
        // A provider with a withdrawn scope cannot authorize the drop.
        throw unavailable()
      }
    }
    check()
    if (!isAbsolute(path) || Buffer.byteLength(path, 'utf8') > 32768 || path.includes('\0')
      || (sep === '/' && path.includes('\\')) || path.split(/[\\/]/u).includes('..')) throw unavailable()
    const absolute = normalize(path).replaceAll('\\', '/')
    if (formatFileMention({ path: absolute, kind }, false) === undefined) throw unavailable()
    let source: Agent | undefined
    try {
      // The registered Agent lookup is the same trusted resolver used by the Gateway.
      source = sourceSessionId === agent.id ? agent : await this.ctx.typert.lookups.get('agent')?.resolve(sourceSessionId) as Agent | undefined
    } catch (_error) {
      // Lookup failures must not disclose a source Session's state.
      check()
      throw unavailable()
    }
    check()
    if (source === undefined) throw unavailable()
    // Keep both provider-owned scope generations through the whole two-sided
    // lookup. A source grant can expire while the destination is awaiting I/O.
    try { scopeChecks.push(this.ctx.fileReferences.captureScope(source), this.ctx.fileReferences.captureScope(agent)) }
    catch (_error) {
      // Scope capture may fail when a provider unloads during lookup.
      throw unavailable()
    }
    check()
    for (const current of [source, agent]) {
      let candidates: FileReferenceCandidate[]
      try { candidates = await this.ctx.fileReferences.list(current, absolute, signal) }
      catch (_error) {
        // Filesystem and provider failures return the same path refusal.
        check()
        throw unavailable()
      }
      check()
      const candidate = candidates.find(candidate => candidate.path === absolute && candidate.kind === kind)
      if (candidate === undefined) throw unavailable()
      try { scopeChecks.push(this.ctx.fileReferences.captureCandidate(current, candidate)) }
      catch (_error) {
        // A stale candidate conveys no authority.
        throw unavailable()
      }
      check()
    }
    check()
    return { path: absolute, kind }
  }

  /**
   * List file and directory candidates for one Agent's working directory.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates from the composed provider.
   */
  @Remote
  list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}

export default SessionFileReferences
