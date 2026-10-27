/** Browser-local identity of an unfinished recall; message text and attachment bytes stay with their owners. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'

export interface RecallIdentity {
  readonly itemId: MessageId
  readonly requestId: SessionRequestId
}

/** One Conversation-owned view of durable browser recall identities. */
export class RecallJournal {
  /** Read an unfinished request without silently discarding malformed or unavailable storage. */
  read(sessionId: SessionId): RecallIdentity | undefined {
    const prefix = this.prefix(sessionId)
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    const key = keys.sort()[0]
    if (key === undefined) return undefined
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('itemId' in value) || typeof value.itemId !== 'string' || value.itemId === ''
      || !('requestId' in value) || typeof value.requestId !== 'string' || value.requestId === ''
      || key !== `${prefix}${encodeURIComponent(value.requestId)}`) {
      throw new Error('Unfinished queue recall identity is invalid')
    }
    return { itemId: value.itemId as MessageId, requestId: value.requestId as SessionRequestId }
  }

  /** Persist before the Host can remove anything; storage failure aborts the recall. */
  write(sessionId: SessionId, identity: RecallIdentity): void {
    localStorage.setItem(`${this.prefix(sessionId)}${encodeURIComponent(identity.requestId)}`, JSON.stringify({ version: 1, ...identity }))
  }

  /** Clear only after local restoration or a definitive not-recalled response. */
  clear(sessionId: SessionId, identity: RecallIdentity): void {
    localStorage.removeItem(`${this.prefix(sessionId)}${encodeURIComponent(identity.requestId)}`)
  }

  private prefix(sessionId: SessionId): string {
    return `dsh.conversation.recall/${encodeURIComponent(sessionId)}/`
  }
}
