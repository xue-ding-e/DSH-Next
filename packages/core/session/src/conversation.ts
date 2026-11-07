/** User-facing conversation generations over the append-only Session log. */

import type { ConversationOp, SessionEvent, SessionSeq, SurfaceEvent } from './types.ts'

/** One committed user-facing replacement and the event that committed it. */
export interface ConversationReplacement extends ConversationOp {
  readonly seq: SessionSeq
}

/** One merged inclusive interval hidden from the current conversation. */
export interface ConversationHiddenRange {
  readonly start: SessionSeq
  readonly end: SessionSeq
}

/**
 * Test whether an event commits a user-facing conversation replacement.
 * @param event - Session event to inspect.
 * @returns whether the event carries a conversation replacement operation.
 */
export function isConversationReplacementEvent(
  event: SessionEvent,
): event is SurfaceEvent & { conversationOp: ConversationOp } {
  const conversationOp = (event as SessionEvent & { conversationOp?: { op?: unknown } }).conversationOp
  return event.type === 'user/message'
    && event.surfaceOp !== undefined
    && event.surfaceOp !== 'append'
    && conversationOp?.op === 'replace'
}

/**
 * Validate one candidate's conversation metadata against the preceding log.
 * @param log - events already committed before the candidate event.
 * @param event - candidate event to validate.
 */
export function validateConversationEvent(log: readonly SessionEvent[], event: SessionEvent): void {
  const op = (event as SessionEvent & { conversationOp?: unknown }).conversationOp
  if (op === undefined) return
  if (event.type !== 'user/message') throw new Error(`session event "${event.type}" cannot carry conversationOp`)
  if (event.surfaceOp === 'append' || event.surfaceOp === undefined) {
    throw new Error('conversation replacement requires a replacement surfaceOp')
  }
  if (op === null || typeof op !== 'object' || Array.isArray(op)
    || Object.keys(op).length !== 3 || (op as { op?: unknown }).op !== 'replace') {
    throw new Error('conversationOp must be an exact replace operation')
  }
  const replacement = op as { op: 'replace'; start?: unknown; end?: unknown }
  if (!Number.isSafeInteger(replacement.start) || (replacement.start as number) < 0
    || !Number.isSafeInteger(replacement.end) || (replacement.end as number) < (replacement.start as number)) {
    throw new Error('conversation replacement requires non-negative safe start <= end')
  }
  const start = replacement.start as number
  const end = replacement.end as number
  if (end >= event.seq || log[start]?.seq !== start || log[end]?.seq !== end) {
    throw new Error('conversation replacement must reference an existing earlier event range')
  }
}

/**
 * Test whether one raw event sequence belongs to the current conversation generation.
 * @param seq - raw event sequence to test.
 * @param hiddenRanges - sorted inclusive ranges hidden by replacements.
 * @returns whether the sequence is visible.
 */
export function isConversationSeqVisible(seq: number, hiddenRanges: readonly ConversationHiddenRange[]): boolean {
  let low = 0
  let high = hiddenRanges.length - 1
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const range = hiddenRanges[middle] as ConversationHiddenRange
    if (seq < range.start) high = middle - 1
    else if (seq > range.end) low = middle + 1
    else return false
  }
  return true
}
