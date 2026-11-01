/** Application-local drag identity. Wire text never supplies authority or reference labels. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'

export const SESSION_REFERENCE_DRAG = 'application/x-dsh-session-reference'

/** A drag is scoped to one mounted client plugin and consumed at most once. */
export class SessionReferenceTransfers {
  private consumed = false
  private current: { token: string; sessionId: SessionId } | undefined
  start(sessionId: SessionId, transfer: DataTransfer): void {
    this.consumed = false
    const token = randomUUID()
    this.current = { token, sessionId }
    transfer.setData(SESSION_REFERENCE_DRAG, token)
  }
  end(): boolean {
    const consumed = this.consumed
    this.current = undefined
    this.consumed = false
    return consumed
  }
  take(transfer: DataTransfer): SessionId | undefined {
    const current = this.current
    if (current === undefined || transfer.getData(SESSION_REFERENCE_DRAG) !== current.token) return undefined
    this.current = undefined
    this.consumed = true
    return current.sessionId
  }
}

/** Resolve an authorized host candidate, then stage a chip without submitting or executing. */
export async function stageSessionReference(
  input: SessionInput,
  sourceId: SessionId,
  lookup: (id: SessionId, signal: AbortSignal) => Promise<readonly SessionReferenceMentionCandidate[]>,
  signal: AbortSignal,
): Promise<'inserted' | 'duplicate' | 'unavailable' | 'changed'> {
  const before = input.state.getSnapshot()
  const insertion = input.captureInsertion()
  signal.throwIfAborted()
  const candidates = await lookup(sourceId, signal)
  signal.throwIfAborted()
  const candidate = candidates.find(item => item.sessionId === sourceId)
  if (candidate === undefined) return 'unavailable'
  const now = input.state.getSnapshot()
  if (now.draftRev !== before.draftRev) return 'changed'
  // Canonical host mentions carry identity after the final label separator.
  // A source rename must not turn a repeated drop into a second reference.
  const identity = candidate.mention.slice(candidate.mention.lastIndexOf(']('))
  if (now.occurrences.some(item => item.source === 'reference' && item.appearance === 'session' && item.ref.endsWith(identity))) return 'duplicate'
  return input.insertReference({
    source: 'reference', ref: candidate.mention, label: candidate.displayTitle ?? candidate.label,
    appearance: 'session', clipboardText: candidate.mention,
  }, { ...insertion, start: insertion.end }) ? 'inserted' : 'changed'
}
