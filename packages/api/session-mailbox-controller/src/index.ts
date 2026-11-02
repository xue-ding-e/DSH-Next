/** Browser-only Remote owner for explicit queue-only routes and single-operation selections. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { HostMailboxAdapter } from '@deepseek-ai/dsh-experimental-session-mailbox/host'
import { MailboxError, MailboxNotAcceptedError, type MailboxRecord } from '@deepseek-ai/dsh-experimental-session-mailbox'
import type { MailboxHandle, MailboxOperation, MailboxRoute, MailboxMessage, MailboxIdentity, MailboxNotAccepted } from './types.ts'
import { MailboxSelectionRegistry } from './selection-registry.ts'

/** Explicit browser authorization is checked in every method, including for owner Peers. */
export class SessionMailboxController extends TypertRemoteService {
  static inject = ['connection']
  private readonly realm: string
  private readonly selections: MailboxSelectionRegistry

  /** Host assembly supplies an already owned adapter; no Remote accepts a root or principal. */
  constructor(ctx: Context, adapter: HostMailboxAdapter) {
    super(ctx, 'sessionMailboxController', { namespace: 'sessionMailbox' })
    this.realm = adapter.realm
    this.selections = new MailboxSelectionRegistry(ctx.connection.browserPeer, adapter)
    ctx.effect(() => () => { this.selections.close() }, 'session-mailbox-controller: grants')
  }

  /** Return only non-secret partition identity, never an authentication token or principal key. */
  @Remote
  identity(): MailboxIdentity {
    this.selections.requireBrowser(this.ctx)
    return { realm: this.realm, owner: 'single-owner' }
  }

  /** Authorize exactly the route confirmed by the owner browser UI. */
  @Remote({ resources: { session: route => route.action === 'send' ? [route.source, route.target] : route.target } })
  grant(route: MailboxRoute, identity: MailboxIdentity): MailboxHandle {
    this.selections.requireBrowser(this.ctx)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- defend direct Host callers as well as generated wire validation.
    if (identity.realm !== this.realm || identity.owner !== 'single-owner') throw new MailboxError('denied')
    return { handle: this.selections.grant(this.ctx, route) }
  }

  /** Prepare one immutable operation; authorization cannot be widened by operation parameters. */
  @Remote
  prepare(grant: string, operation: MailboxOperation): MailboxHandle {
    return { handle: this.selections.prepare(this.ctx, grant, operation) }
  }

  /** Consume one handle; queued messages are never routed to an Agent by this controller. */
  @Remote
  async execute(selection: string, signal: AbortSignal): Promise<MailboxMessage | readonly MailboxMessage[] | MailboxNotAccepted> {
    signal.throwIfAborted()
    let result: MailboxRecord | readonly MailboxRecord[]
    try { result = await this.selections.execute(this.ctx, selection) } catch (error) {
      if (error instanceof MailboxNotAcceptedError) return { outcome: 'not-accepted' }
      throw error
    }
    const view = (record: MailboxRecord): MailboxMessage => ({
      id: record.id, source: record.source, target: record.target, text: record.text,
      status: record.status, trust: record.trust, mode: record.mode,
    })
    return 'id' in result ? view(result) : result.map(view)
  }

  /** Cancel a route when its UI closes or the user withdraws consent. */
  @Remote
  revoke(grant: string): void {
    this.selections.revoke(this.ctx, grant)
  }
}

export { apply, Config, inject } from './plugin.ts'
