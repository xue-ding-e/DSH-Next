import { describe, expect, it } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationPresentationState } from '../src/client/conversation/presentation.ts'

function replacement(start: number, end: number, seq = end + 1): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'user/message', seq, time: seq, data: {},
      surfaceOp: { op: 'replace' }, conversationOp: { op: 'replace', start, end },
    },
  } as SessionEventLikeEntry
}

function event(seq: number, type = 'turn/start'): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq, time: seq, data: {} } } as SessionEventLikeEntry
}

describe('ConversationPresentationState', () => {
  it('hides replaced raw entries across loaded and appended windows', () => {
    const state = new ConversationPresentationState()
    const first = replacement(10, 12)
    state.replace([event(9), first, replacement(0, 4, 20)])
    expect(state.hasReplacement([first])).toBe(true)
    expect(state.visible(event(11))).toBe(false)
    expect(state.visible(event(15))).toBe(true)

    state.apply([replacement(3, 11, 22), replacement(5, 6, 23)])
    expect(state.visible(event(4))).toBe(false)
    expect(state.visible(event(10))).toBe(false)
    expect(state.hasReplacement([event(30), { type: 'transient', event: {} } as SessionEventLikeEntry])).toBe(false)
  })

  it('resets visibility and ignores non-replacement entries', () => {
    const state = new ConversationPresentationState()
    state.apply([event(1), { type: 'transient', event: {} } as SessionEventLikeEntry])
    expect(state.hasReplacement([event(1)])).toBe(false)
    state.replace([])
    expect(state.visible(event(1))).toBe(true)
  })
})
