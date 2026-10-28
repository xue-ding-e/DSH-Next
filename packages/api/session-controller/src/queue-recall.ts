/** Atomic queued-user-message handoff and idempotent receipt recovery. */
import { isDeepStrictEqual } from 'node:util'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FileUploads, StagedAttachment } from '@deepseek-ai/dsh-client-file-upload'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { QueueRecallState } from './queue-recall-projection.ts'
import type { QueueRecallValue, SessionRequestId, SessionUpdateQueueRequest, SessionUpdateQueueValue } from './types.ts'

export class QueueRecallController {
  // Live receipts are cached; the atomic Inbox handoff remains recoverable from the Session log.
  private readonly recalled = new WeakMap<Session, Map<SessionRequestId, {
    readonly itemId: SessionUpdateQueueRequest['itemId']
    readonly value: QueueRecallValue
  }>>()

  /**
   * Recover an already committed handoff after the caller reloads, without touching pending work.
   * @param agent - exact resumed Session owner.
   * @param itemId - original occurrence identity saved by the caller.
   * @param requestId - original recall operation, not a new prompt identity.
   * @param projection - registered own-Session recovery reader.
   * @param fileUploads - receipt owner used to remint authority after restart.
   * @returns full authoritative draft and current Session-scoped receipts.
   */
  recover(
    agent: Agent,
    itemId: SessionUpdateQueueRequest['itemId'],
    requestId: SessionRequestId,
    projection: ProjectionHandle<QueueRecallState>,
    fileUploads: FileUploads,
  ): SessionUpdateQueueValue {
    const message = projection.stateOf(agent.session).recalls.find(value =>
      value.requestId === requestId && value.message.id === itemId)?.message
    if (message === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'no committed recall exists for this occurrence', { itemId })
    }
    return this.recall(agent, itemId, { kind: 'recall', requestId, expectedContent: message.content }, projection, fileUploads)
  }

  /** Recall never awaits between its authoritative CAS check and durable removal. */
  recall(
    agent: Agent,
    itemId: SessionUpdateQueueRequest['itemId'],
    action: Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'recall' }>,
    projection: ProjectionHandle<QueueRecallState>,
    fileUploads: FileUploads,
  ): SessionUpdateQueueValue {
    const committedRecall = () => projection.stateOf(agent.session).recalls
      .find(value => value.requestId === action.requestId)
    const cached = this.recalled.get(agent.session)?.get(action.requestId)
    if (cached !== undefined) {
      if (cached.itemId !== itemId || !isDeepStrictEqual(cached.value.content, action.expectedContent)) {
        throw new RemoteError('gateway/bad-request', 'recall request identity was reused for different content', {})
      }
      if (committedRecall()?.message.id !== itemId) {
        throw new RemoteError('gateway/internal', 'queue recall has not committed yet', {})
      }
      return { accepted: true, recalled: cached.value }
    }
    const recovered = committedRecall()?.message
    if (recovered !== undefined && recovered.id !== itemId) {
      throw new RemoteError('gateway/bad-request', 'recall request identity was reused for another occurrence', {})
    }
    const message = recovered ?? agent.inbox.nextTurn.find(candidate => candidate.id === itemId)
    if (message === undefined || message.source.kind !== 'user') {
      throw new RemoteError('session/queue-item-not-found', 'queued user item is no longer pending', { itemId })
    }
    if (!isDeepStrictEqual(message.content, action.expectedContent)) {
      throw new RemoteError('gateway/bad-request', 'queued content changed before recall', {})
    }
    const attachments: StagedAttachment[] = []
    for (const part of message.content) {
      if (part.type === 'text') continue
      if (part.type === 'image' && 'attachment' in part) {
        attachments.push({ type: 'image', attachment: part.attachment, encodedBytes: part.attachment.bytes })
      } else if (part.type === 'file') {
        attachments.push({ type: 'file', attachment: part.attachment })
      } else {
        throw new RemoteError('gateway/bad-request', 'queued content cannot be restored to the composer', {})
      }
    }
    const child = agent.session.header.origin === 'subagent'
    if (child && attachments.some(attachment => attachment.type === 'file')) {
      throw new RemoteError('gateway/bad-request', 'child conversations do not accept recalled file attachments', {})
    }
    // The caller already enforced continuation ownership. Child images use
    // their existing inline admission path; no child receipt authority is minted.
    using staged = !child && attachments.length > 0
      ? fileUploads.stageRecalled(agent, attachments)
      : { receiptIds: [], commit() {}, [Symbol.dispose]() {} }
    const value: QueueRecallValue = {
      content: message.content,
      attachments: attachments.map((attachment, index) => {
        if (child && attachment.type === 'image') return { type: 'image', image: attachment.attachment }
        const receiptId = staged.receiptIds[index]
        if (receiptId === undefined) throw new Error('missing recalled attachment receipt')
        return attachment.type === 'image'
          ? { type: 'image', receiptId, image: attachment.attachment }
          : { type: 'file', receiptId, file: attachment.attachment }
      }),
    }
    let results = this.recalled.get(agent.session)
    if (results === undefined) {
      results = new Map()
      this.recalled.set(agent.session, results)
    }
    // Observers may reenter after the durable append but before recall returns.
    // They can reuse this staging only after the projection confirms commit.
    results.set(action.requestId, { itemId, value })
    let removed = true
    try {
      if (recovered === undefined) removed = agent.inbox.recall(itemId, action.requestId)
    } catch (error) {
      // Inbox commits before notifying observers. A throwing observer must not
      // discard the recovered draft or make a retry remove another occurrence.
      const committed = committedRecall()
      if (committed?.message.id !== itemId) {
        results.delete(action.requestId)
        throw error
      }
    }
    if (!removed) {
      results.delete(action.requestId)
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId })
    }
    staged.commit()
    if (!child && 'rpcId' in message.source) fileUploads.retirePrompt(agent, message.source.rpcId)
    return { accepted: true, recalled: value }
  }

}
