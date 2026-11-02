/** Host-only explicit mailbox selections; never registered as a Remote or model tool. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { MailboxError, type MailboxId } from './index.ts'

/** Exact operation selected by the user through a future trusted Host UI handler. */
export type MailboxSelection =
  | { readonly action: 'send'; readonly source: SessionId; readonly target: SessionId; readonly requestId: string; readonly text: string }
  | { readonly action: 'inbox'; readonly target: SessionId }
  | { readonly action: 'ack'; readonly target: SessionId; readonly id: MailboxId }

interface PendingSelection {
  readonly peer: PeerScope
  readonly selection: MailboxSelection
  readonly cancelSignal: AbortSignal
  readonly deadline: number
}

/** Internal single-operation lease; validation never makes a consumed token reusable. */
export interface MailboxOperationLease {
  /** Exact authenticated connection instance that owns the selection. */
  readonly peer: PeerScope
  /** Immutable operation and user-selected values. */
  readonly selection: MailboxSelection
  /** Independent selection cancellation, Peer disposal and executing-call cancellation. */
  readonly signal: AbortSignal
  /** Recheck current execution, selection cancellation and monotonic expiry.
   * @param ctx - the current trusted Host invocation context.
   */
  check(ctx: Context): void
  /** End this lease; subsequent checks refuse access. */
  dispose(): void
}

/**
 * Authority owned by one Host adapter. Only trusted Host UI code may call issue.
 * Issuance is not an authentication endpoint; no wire JSON or model tool receives this object.
 */
export class HostMailboxSelections {
  private readonly selections = new WeakMap<object, PendingSelection>()

  /**
   * @param ttlMs - explicit short selection lifetime, capped at 30 seconds to reject stale selections.
   * @param now - monotonic clock; defaults to the platform clock and can be supplied by a deterministic Host test.
   */
  constructor(private readonly ttlMs: number, private readonly now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30_000) throw new MailboxError('invalid')
  }

  /** Bind the exact user-selected operation to the current authenticated owner Peer.
   * @param ctx - trusted Host invocation context; never constructed from wire identity fields.
   * @param selection - explicit source, target and operation selected by the user.
   * @param cancelSignal - selection cancellation, distinct from successful completion of the issuing RPC.
   * @returns an opaque, single-claim process-local capability with no serializable identity fields.
   */
  issue(ctx: Context, selection: MailboxSelection, cancelSignal: AbortSignal): object {
    const invocation = ctx.invocation
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- principal kinds are merge-extensible across Host assemblies.
    if (!invocation || invocation.peer.principal.kind !== 'owner'
      || invocation.peer.signal.aborted || invocation.signal.aborted || cancelSignal.aborted) throw new MailboxError('denied')
    const token = Object.freeze({})
    this.selections.set(token, {
      peer: invocation.peer, selection: Object.freeze({ ...selection }), cancelSignal, deadline: this.now() + this.ttlMs,
    })
    return token
  }

  /** Consume exactly once before returning a private operation lease, including failed claim attempts.
   * @param ctx - current Host invocation context, possibly a later call on the same Peer.
   * @param token - exact capability returned by this issuer.
   * @returns a bounded operation lease; expired, cancelled, forged and replayed tokens are refused.
   */
  claim(ctx: Context, token: object): MailboxOperationLease {
    const selected = this.selections.get(token)
    this.selections.delete(token)
    const invocation = ctx.invocation
    if (!selected || !invocation) throw new MailboxError('denied')
    let active = true
    const signal = AbortSignal.any([selected.peer.signal, selected.cancelSignal, invocation.signal])
    const check = (current: Context): void => {
      const execution = current.invocation
      if (!active || !execution || execution.peer !== selected.peer || signal.aborted || execution.signal.aborted
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- principal kinds are merge-extensible across Host assemblies.
        || execution.peer.principal.kind !== 'owner' || this.now() >= selected.deadline) throw new MailboxError('denied')
    }
    check(ctx)
    return {
      peer: selected.peer, selection: selected.selection, signal, check,
      dispose: () => { active = false },
    }
  }
}
