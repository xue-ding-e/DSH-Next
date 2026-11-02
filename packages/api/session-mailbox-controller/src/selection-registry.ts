/** Bounded Host-owned route grants. Wire fields never manufacture browser authority. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MailboxError, type MailboxId } from '@deepseek-ai/dsh-experimental-session-mailbox'
import { MailboxOutcomeUnavailableError, type HostMailboxAdapter } from '@deepseek-ai/dsh-experimental-session-mailbox/host'
import type { MailboxOperation, MailboxRoute } from './types.ts'

interface Grant {
  readonly route: MailboxRoute
  readonly cancel: AbortController
  readonly expires: number
  readonly timer: ReturnType<typeof setTimeout>
}
interface Selection { readonly grant: Grant; readonly token: object }

/**
 * One Host's short-lived grants. The captured browser Peer is supplied by Connection,
 * not by a method argument. Browser tabs share that principal and are not isolated.
 */
export class MailboxSelectionRegistry {
  private readonly grants = new Map<string, Grant>()
  private readonly selections = new Map<string, Selection>()
  private closed = false

  /** @param browserPeer - exact Host Connection browser Peer, never a reconstructed identity.
   * @param adapter - privately owned queue-only adapter.
   */
  constructor(
    private readonly browserPeer: PeerScope,
    private readonly adapter: HostMailboxAdapter,
  ) {}

  /** Admit only a live invocation from the captured authenticated browser transport. */
  requireBrowser(ctx: Context): void {
    const call = ctx.invocation
    if (this.closed || !call || call.peer !== this.browserPeer || call.signal.aborted
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- principal kinds are extensible in Host assemblies.
      || this.browserPeer.signal.aborted || call.peer.principal.kind !== 'owner') throw new MailboxError('denied')
    this.sweep()
  }

  /** Expiration aborts active leases as well as removing unclaimed selections. */
  private sweep(): void {
    for (const [id, grant] of this.grants) {
      if (performance.now() >= grant.expires) this.remove(id, grant)
    }
  }
  private remove(id: string, grant: Grant): void {
    clearTimeout(grant.timer)
    grant.cancel.abort()
    this.grants.delete(id)
    for (const [key, selection] of this.selections) {
      if (selection.grant === grant) this.selections.delete(key)
    }
  }

  /** Explicit owner authorization, not a claim that the transport proves a physical click. */
  grant(ctx: Context, route: MailboxRoute): string {
    this.requireBrowser(ctx)
    if (!route.target || route.target.length > 256
      || route.action === 'send' && (!route.source || route.source.length > 256 || route.source === route.target)) throw new MailboxError('denied')
    if (this.grants.size >= 32) throw new MailboxError('denied')
    const handle = randomUUID()
    const timer = setTimeout(() => {
      const current = this.grants.get(handle)
      if (current) this.remove(handle, current)
    }, 30_000)
    timer.unref()
    this.grants.set(handle, {
      route: Object.freeze({ ...route }), cancel: new AbortController(), expires: performance.now() + 30_000, timer,
    })
    return handle
  }

  /** Freeze one operation on a previously authorized route. */
  prepare(ctx: Context, handle: string, operation: MailboxOperation): string {
    this.requireBrowser(ctx)
    const grant = this.grants.get(handle)
    if (!grant || grant.route.action !== operation.action || this.selections.size >= 64) throw new MailboxError('denied')
    if (operation.action === 'send' && (operation.requestId.length === 0 || operation.requestId.length > 256
      || Buffer.byteLength(operation.text, 'utf8') > 16_384)) throw new MailboxError('denied')
    if (operation.action === 'ack' && (!operation.id || operation.id.length > 256)) throw new MailboxError('denied')
    const selection = operation.action === 'send' && grant.route.action === 'send'
      ? { ...grant.route, requestId: operation.requestId, text: operation.text }
      : operation.action === 'ack' ? { action: 'ack' as const, target: grant.route.target, id: brandString<MailboxId>(operation.id) }
        : { action: 'inbox' as const, target: grant.route.target }
    const token = this.adapter.selections.issue(ctx, selection, grant.cancel.signal, grant.expires)
    const key = randomUUID()
    this.selections.set(key, { grant, token })
    return key
  }

  /** Consume before awaiting; concurrent replay cannot reach the adapter a second time. */
  async execute(ctx: Context, handle: string) {
    this.requireBrowser(ctx)
    const selected = this.selections.get(handle)
    this.selections.delete(handle)
    if (!selected || selected.grant.cancel.signal.aborted) throw new MailboxError('denied')
    let result: Awaited<ReturnType<HostMailboxAdapter['execute']>>
    try { result = await this.adapter.execute(ctx, selected.token) } catch (error) {
      this.requireBrowser(ctx)
      if (this.isRevoked(selected.grant)) throw new MailboxError('denied')
      throw error
    }
    this.sweep()
    if (this.isRevoked(selected.grant) || this.closed || ctx.invocation?.signal.aborted) {
      if (selected.grant.route.action !== 'inbox') throw new MailboxOutcomeUnavailableError()
      throw new MailboxError('denied')
    }
    return result
  }

  private isRevoked(grant: Grant): boolean { return grant.cancel.signal.aborted }

  /** Revocation cancels every selection and in-flight lease on this route. */
  revoke(ctx: Context, handle: string): void {
    this.requireBrowser(ctx)
    const grant = this.grants.get(handle)
    if (grant) this.remove(handle, grant)
  }

  /** Host unload invalidates all outstanding browser grants. */
  close(): void {
    this.closed = true
    for (const [id, grant] of this.grants) this.remove(id, grant)
  }
}
