/** Loaded-window user-facing conversation visibility for one Session. */

import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

interface ConversationHiddenRange { readonly start: number; readonly end: number }

/** Mutable presentation state owned by one Conversation binding. */
export class ConversationPresentationState {
  private hiddenRanges: ConversationHiddenRange[] = []

  /**
   * Reset the current generation and apply a complete loaded event window.
   * @param entries - loaded Session entries in chronological order.
   */
  replace(entries: readonly SessionEventLikeEntry[]): void {
    this.hiddenRanges = []
    this.apply(entries)
  }

  /**
   * Record conversation ranges hidden by replacement events in an appended window.
   * @param entries - newly loaded or appended Session entries.
   */
  apply(entries: readonly SessionEventLikeEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== 'event') continue
      const event = entry.event as {
        type?: unknown
        surfaceOp?: { op?: unknown }
        conversationOp?: { op?: unknown; start?: unknown; end?: unknown }
      }
      if (event.type !== 'user/message' || event.surfaceOp?.op !== 'replace' || event.conversationOp?.op !== 'replace'
        || !Number.isSafeInteger(event.conversationOp.start) || !Number.isSafeInteger(event.conversationOp.end)) continue
      this.addHiddenRange(event.conversationOp.start as number, event.conversationOp.end as number)
    }
  }

  /**
   * Check whether a window contains a user-message conversation replacement.
   * @param entries - Session entries to inspect.
   * @returns whether the window contains a replacement event.
   */
  hasReplacement(entries: readonly SessionEventLikeEntry[]): boolean {
    return entries.some(entry => entry.type === 'event'
      && entry.event.type === 'user/message'
      && (entry.event as { surfaceOp?: { op?: unknown }; conversationOp?: { op?: unknown } }).surfaceOp?.op === 'replace'
      && (entry.event as { conversationOp?: { op?: unknown } }).conversationOp?.op === 'replace')
  }

  /**
   * Check whether an entry belongs to the current conversation generation.
   * @param entry - Session entry to test.
   * @returns whether the entry remains visible after replacements.
   */
  visible(entry: SessionEventLikeEntry): boolean {
    let low = 0
    let high = this.hiddenRanges.length - 1
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2)
      const range = this.hiddenRanges[middle] as ConversationHiddenRange
      if (entry.event.seq < range.start) high = middle - 1
      else if (entry.event.seq > range.end) low = middle + 1
      else return false
    }
    return true
  }

  private addHiddenRange(start: number, end: number): void {
    const ranges = [...this.hiddenRanges, { start, end }].sort((left, right) => left.start - right.start || left.end - right.end)
    const merged: ConversationHiddenRange[] = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous === undefined || range.start > previous.end + 1) merged.push({ ...range })
      else if (range.end > previous.end) merged[merged.length - 1] = { start: previous.start, end: range.end }
    }
    this.hiddenRanges = merged
  }
}
