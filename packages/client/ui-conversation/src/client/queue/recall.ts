/** Session-bound recall transaction: prepare locally before removing authoritative pending input. */
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId, SessionUpdateQueueValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RecallJournal } from './recall-journal.ts'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'

type QueuedMessage = InboxState['next-turn'][number]
type Recalled = NonNullable<SessionUpdateQueueValue['recalled']>

interface RecallOperation<T> {
  readonly item: QueuedMessage
  readonly requestId: SessionRequestId
  readonly prepared: T
  recalled?: Recalled
}

/** Owns uncertain outcomes so another key press retries the same operation, never another queue row. */
export class QueueRecall<T> {
  private readonly pending = new Map<SessionId, RecallOperation<T>>()
  private readonly running = new Set<SessionId>()
  private readonly journal = new RecallJournal()

  constructor(private readonly prepare: (session: SessionFace, item: QueuedMessage, signal?: AbortSignal, recalledRequestId?: SessionRequestId) => Promise<T>,
    private readonly release: (prepared: T) => void,
    private readonly requestId: () => SessionRequestId) {}

  /** Whether a pending row or an unresolved prior request can be recalled. */
  available(session: SessionFace): boolean {
    if (this.running.has(session.sessionId)) return false
    if (this.pending.has(session.sessionId) || this.latest(session) !== undefined) return true
    try { return this.journal.read(session.sessionId) !== undefined } catch (_error: unknown) {
      // Do not infer an empty queue from unreadable recovery storage. The
      // owned recall operation will surface the failure without removing input.
      return true
    }
  }

  /** Whether this Session owns an unfinished operation independently of currently queued rows. */
  recoverable(session: SessionFace): boolean {
    return this.pending.has(session.sessionId) || this.journal.read(session.sessionId) !== undefined
  }

  /** Prepare first, then CAS-remove exactly one row; transport failures retain the same retry identity. */
  async recall(session: SessionFace, stillAccepts: () => boolean, signal?: AbortSignal): Promise<{ prepared: T; recalled: Recalled; commit(): void } | undefined> {
    if (this.running.has(session.sessionId)) return undefined
    this.running.add(session.sessionId)
    try {
      let operation = this.pending.get(session.sessionId)
      if (operation === undefined) {
        const saved = this.journal.read(session.sessionId)
        let item: QueuedMessage | undefined
        let recalledRequestId: SessionRequestId | undefined
        if (saved === undefined) item = this.latest(session)
        else {
          const inbox = session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
          item = inbox?.['next-turn'].find(row => row.id === saved.itemId && row.source.kind === 'user')
          if (item === undefined) {
            const recovered = await session.updateQueue(saved.itemId, { kind: 'recover-recall', requestId: saved.requestId })
            if (!recovered.ok) {
              if (recovered.error.code === 'session/queue-item-not-found') this.journal.clear(session.sessionId, saved)
              throw new Error(`queue recall recovery: ${recovered.error.code}`)
            }
            if (recovered.value.recalled === undefined) throw new Error('queue recall recovery: missing durable result')
            item = { id: saved.itemId, role: 'user', source: { kind: 'user' }, content: recovered.value.recalled.content }
            recalledRequestId = saved.requestId
          }
        }
        if (item === undefined) return undefined
        const prepared = await this.prepare(session, item, signal, recalledRequestId)
        if (!stillAccepts() || signal?.aborted === true) {
          this.release(prepared)
          return undefined
        }
        operation = { item, prepared, requestId: saved?.requestId ?? this.requestId() }
        try { this.journal.write(session.sessionId, { itemId: item.id, requestId: operation.requestId }) } catch (error) {
          this.release(prepared)
          throw error
        }
        this.pending.set(session.sessionId, operation)
      }
      if (!stillAccepts() || signal?.aborted === true) return undefined
      // A retry retains its original Session, item, expected content and id.
      const result = await session.updateQueue(operation.item.id, {
        kind: 'recall', requestId: operation.requestId, expectedContent: operation.item.content,
      })
      if (!result.ok) {
        if (operation.recalled === undefined && (result.error.code === 'session/queue-item-not-found' || result.error.code === 'gateway/bad-request')) {
          this.journal.clear(session.sessionId, { itemId: operation.item.id, requestId: operation.requestId })
          this.pending.delete(session.sessionId)
          this.release(operation.prepared)
        }
        throw new Error(`queue recall: ${result.error.code}: ${result.error.message}`)
      }
      if (result.value.recalled === undefined) throw new Error('queue recall: missing authoritative result')
      // No asynchronous work remains after acceptance. The caller adopts the
      // already-prepared draft synchronously, never looking up the active tab.
      operation.recalled = result.value.recalled
      return this.ready(session, operation, result.value.recalled)
    } finally {
      this.running.delete(session.sessionId)
    }
  }

  /** Release retained attachment preparations when the owning Conversation service unloads. */
  dispose(): void {
    for (const operation of this.pending.values()) this.release(operation.prepared)
    this.pending.clear()
  }

  private ready(session: SessionFace, operation: RecallOperation<T>, recalled: Recalled) {
    return { prepared: operation.prepared, recalled, commit: () => {
      if (this.pending.get(session.sessionId) === operation) {
        this.journal.clear(session.sessionId, { itemId: operation.item.id, requestId: operation.requestId })
        this.pending.delete(session.sessionId)
      }
    } }
  }

  private latest(session: SessionFace): QueuedMessage | undefined {
    const inbox = session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
    const submissions = session.getSnapshot().pendingSubmissions
    const inTranscript = new Set(submissions.filter(item => item.placement === 'transcript').map(item => item.requestId))
    return inbox?.['next-turn'].findLast(item => item.source.kind === 'user'
      && (!('rpcId' in item.source) || !inTranscript.has(item.source.rpcId)))
  }
}
