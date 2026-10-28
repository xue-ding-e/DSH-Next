/** Browser-local identity of an unfinished recall; message text and attachment bytes stay with their owners. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'

/** Session-local occurrence and request identifiers; excludes message text and attachment bytes. */
export interface RecallIdentity {
  readonly itemId: MessageId
  readonly requestId: SessionRequestId
}

/** One Conversation-owned view of durable browser recall identities. */
export class RecallJournal {
  /**
   * Read an unfinished request without silently discarding malformed or unavailable storage.
   * @param sessionId - Session whose browser-local recovery identities are searched.
   * @returns the first identity in sorted storage-key order, or undefined when no stored value remains.
   * @throws If storage access fails or the selected stored identity is malformed.
   */
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

  /**
   * Persist before the Host can remove anything; storage failure aborts the recall.
   * @param sessionId - Session that owns the unfinished request.
   * @param identity - occurrence and stable request identifiers to persist.
   * @throws If browser storage cannot persist the identity.
   */
  write(sessionId: SessionId, identity: RecallIdentity): void {
    localStorage.setItem(`${this.prefix(sessionId)}${encodeURIComponent(identity.requestId)}`, JSON.stringify({ version: 1, ...identity }))
  }

  /**
   * Clear only after local restoration or a definitive not-recalled response.
   * @param sessionId - Session that owns the unfinished request.
   * @param identity - request identity whose storage entry is removed.
   * @throws If browser storage cannot remove the entry; callers retain recovery state.
   */
  clear(sessionId: SessionId, identity: RecallIdentity): void {
    localStorage.removeItem(`${this.prefix(sessionId)}${encodeURIComponent(identity.requestId)}`)
  }

  private prefix(sessionId: SessionId): string {
    return `dsh.conversation.recall/${encodeURIComponent(sessionId)}/`
  }
}
