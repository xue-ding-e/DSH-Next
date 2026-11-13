/** Queue-only, single-Host mailbox candidate; no Agent activation or model input. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'

/** Durable mailbox identity, distinct from an Agent inbox receipt. */
export type MailboxId = Branded<'MailboxId'>
/** Host-canonical principal identity; contains no credential. */
export type MailboxPrincipalKey = Branded<'MailboxPrincipalKey'>
/** Identity resolved by the Host from an opaque capability, never tool JSON. */
export interface MailboxActor {
  /** Authenticated Host identity used by the policy; never resolved from message text. */
  readonly principal: Principal
  /** Stable canonical identity for durable sender attribution and retry isolation. */
  readonly principalKey: MailboxPrincipalKey
  /** Sending or reading Session bound by the Host capability. */
  readonly sessionId: SessionId
}
/** All values are explicit; no absent-principal or owner fallback exists. */
export interface MailboxPolicy {
  /** Maximum retained records, including terminal retry tombstones. */
  readonly maxRecords: number
  /** Maximum complete serialized UTF-8 record size, including terminal state. */
  readonly maxRecordBytes: number
  /** Resolve a trusted capability at admission.
   * @param caller - opaque capability issued by the Host.
   * @returns authenticated actor, or undefined to refuse admission.
   */
  resolve(caller: object): MailboxActor | undefined
  /** Check current source and recipient grants without activating either Session.
   * @param actor - identity established by the Host resolver.
   * @param action - mailbox operation being admitted.
   * @param source - original sender Session.
   * @param target - recipient Session.
   * @returns whether current policy permits this exact operation.
   */
  allows(actor: MailboxActor, action: 'send' | 'inbox' | 'outbox' | 'ack' | 'cancel', source: SessionId, target: SessionId): boolean
  /** Check target lifecycle and receive opt-in without materialization.
   * @param target - recipient Session.
   * @returns whether a new send or retry may be admitted.
   */
  canReceive(target: SessionId): boolean
}
const recordSchema = z.object({
  id: z.string().transform(brandString<MailboxId>),
  principalKey: z.string().transform(brandString<MailboxPrincipalKey>),
  source: z.string().transform(brandString<SessionId>),
  target: z.string().transform(brandString<SessionId>),
  requestId: z.string(),
  text: z.string(),
  trust: z.literal('untrusted-agent-content'),
  mode: z.literal('queue-only'),
  status: z.enum(['queued', 'acknowledged', 'cancelled']),
})
/** Authoritative record also supplies both inbox and outbox views. */
export type MailboxRecord = Readonly<z.infer<typeof recordSchema>>
const spec = defineDomain({
  name: 'session_mailbox', version: 1,
  tables: { messages: domainTable<MailboxId, MailboxRecord>(recordSchema) },
})
/** Typed refusal without exposing target existence or content. */
export class MailboxError extends Error {
  constructor(readonly code: 'denied' | 'conflict' | 'limit' | 'closed' | 'not-queued' | 'invalid' | 'unknown-state', options?: ErrorOptions) {
    super(`session mailbox: ${code}`, options)
    this.name = 'MailboxError'
  }
}
/** Proven absent retry identity; no write was attempted for this send. */
export class MailboxNotAcceptedError extends MailboxError {
  constructor(code: 'invalid' | 'limit') { super(code); this.name = 'MailboxNotAcceptedError' }
}
/**
 * Internal service candidate. The Host must exclusively own the storage root.
 * Every mutation is serialized, including policy checks and duplicate lookup.
 * Admission fixes authorization before the write; later revocation does not retract it.
 * Remote adapters requiring response-time permission must recheck before exposing receipts.
 * No method injects content into a model, starts turns, restores sessions or forwards messages.
 */
export class SessionMailbox {
  private chain: Promise<void> = Promise.resolve()
  private closing?: Promise<void>
  private failed = false
  private constructor(private readonly domain: Domain<typeof spec>, private readonly policy: MailboxPolicy) {}

  /** Open validated durable state; caller owns close and exclusive Host lifetime.
   * @param facility - existing domain facility over the Host storage backend.
   * @param policy - trusted identity, permission, lifecycle and bound decisions.
   * @returns a queue-only mailbox with no activation dependency.
   */
  static async open(facility: DomainFacility, policy: MailboxPolicy): Promise<SessionMailbox> {
    for (const limit of [policy.maxRecords, policy.maxRecordBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new MailboxError('invalid')
    }
    return new SessionMailbox(await facility.open(spec), policy)
  }

  /** Persist one original message, without reading sender history or waking the recipient.
   * @param caller - opaque Host capability resolved afresh at the serialized admission point.
   * @param request - target, caller retry key and untrusted text; no sender or wake flag.
   * @param signal - cancellation before durable-write admission only.
   * @returns the durable receipt; authorized retries to an accepting target return the existing terminal or pending record.
   */
  send(
    caller: object,
    request: { readonly target: SessionId; readonly requestId: string; readonly text: string },
    signal: AbortSignal,
  ): Promise<MailboxRecord> {
    const input = { ...request }
    return this.run(async () => {
      signal.throwIfAborted()
      const actor = this.actor(caller)
      this.authorize(actor, 'send', actor.sessionId, input.target)
      if (actor.sessionId === input.target || !this.policy.canReceive(input.target)) throw new MailboxError('denied')
      const id = brandString<MailboxId>(createHash('sha256').update(JSON.stringify([actor.principalKey, actor.sessionId, input.requestId])).digest('hex'))
      const table = this.domain.table('messages')
      const prior = table.get(id)
      if (prior) {
        if (prior.target !== input.target || prior.text !== input.text) throw new MailboxError('conflict')
        return structuredClone(prior)
      }
      if (!input.requestId.trim() || !input.text.trim()) throw new MailboxNotAcceptedError('invalid')
      const record: MailboxRecord = { id, principalKey: actor.principalKey, source: actor.sessionId, target: input.target, requestId: input.requestId, text: input.text, trust: 'untrusted-agent-content', mode: 'queue-only', status: 'queued' }
      if (table.size >= this.policy.maxRecords || Buffer.byteLength(JSON.stringify({ ...record, status: 'acknowledged' }), 'utf8') > this.policy.maxRecordBytes) throw new MailboxNotAcceptedError('limit')
      await this.persist(record)
      return structuredClone(record)
    })
  }

  /** Read only the caller's side, rechecking current permissions for every record.
   * @param caller - opaque authenticated Host capability.
   * @param side - inbox or outbox belonging to the resolved session.
   * @returns isolated record snapshots, not Session history.
   */
  list(caller: object, side: 'inbox' | 'outbox'): readonly MailboxRecord[] {
    if (this.closing) throw new MailboxError('closed')
    if (this.failed) throw new MailboxError('unknown-state')
    const actor = this.actor(caller)
    const records: MailboxRecord[] = []
    for (const [, record] of this.domain.table('messages').entries()) {
      if ((side === 'inbox' ? record.target : record.source) !== actor.sessionId) continue
      if (side === 'outbox' && record.principalKey !== actor.principalKey) continue
      if (this.policy.allows(actor, side, record.source, record.target)) records.push(structuredClone(record))
    }
    return records
  }

  /** Acknowledge receipt or cancel pending delivery; neither means model execution completed.
   * @param caller - authenticated recipient for ack, original principal and sender for cancel.
   * @param id - existing mailbox receipt.
   * @param action - terminal transition; competing transitions cannot both win.
   * @returns the durable terminal record, including same-action retries.
   */
  settle(caller: object, id: MailboxId, action: 'ack' | 'cancel'): Promise<MailboxRecord> {
    return this.run(async () => {
      const actor = this.actor(caller)
      const table = this.domain.table('messages')
      const record = table.get(id)
      if (!record || (action === 'ack' ? record.target !== actor.sessionId : record.source !== actor.sessionId || record.principalKey !== actor.principalKey)) throw new MailboxError('denied')
      this.authorize(actor, action, record.source, record.target)
      const status = action === 'ack' ? 'acknowledged' : 'cancelled'
      if (record.status === status) return structuredClone(record)
      if (record.status !== 'queued') throw new MailboxError('not-queued')
      const next = { ...record, status } as const
      await this.persist(next)
      return structuredClone(next)
    })
  }

  /** Reject new operations, drain admitted writes, then release the domain.
   * @returns the shared disposal promise.
   */
  close(): Promise<void> {
    this.closing ??= this.chain.then(() => this.domain.close())
    return this.closing
  }
  private async persist(record: MailboxRecord): Promise<void> {
    try {
      await this.domain.table('messages').put(record.id, record)
    } catch (error) {
      // A file publish can fail after rename. Never overwrite an uncertain receipt.
      this.failed = true
      throw new MailboxError('unknown-state', { cause: error })
    }
  }
  private actor(caller: object): MailboxActor {
    const actor = this.policy.resolve(caller)
    if (!actor) throw new MailboxError('denied')
    return actor
  }
  private authorize(actor: MailboxActor, action: Parameters<MailboxPolicy['allows']>[1], source: SessionId, target: SessionId): void {
    if (!this.policy.allows(actor, action, source, target)) throw new MailboxError('denied')
  }
  private run<T>(job: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new MailboxError('closed'))
    const result = this.chain.then(() => {
      if (this.failed) throw new MailboxError('unknown-state')
      return job()
    })
    this.chain = result.then(() => {}, () => {})
    return result
  }
}
