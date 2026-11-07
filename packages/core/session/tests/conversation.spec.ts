import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  isConversationReplacementEvent,
  isConversationSeqVisible,
  validateConversationEvent,
} from '@deepseek-ai/dsh-session'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

function event(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(2),
    time: 2,
    data: createUserMessage({ content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' } }),
    surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
    ...overrides,
  } as SessionEvent
}

describe('conversation replacement metadata', () => {
  it('recognizes replacement user events and validates their raw range', () => {
    const session = Session.create(SessionId('conversation-validation'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const candidate = event({
      seq: SessionSeq(2),
      conversationOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(1) },
    })

    expect(isConversationReplacementEvent(candidate)).toBe(true)
    expect(() => validateConversationEvent(session.snapshotEvents(), candidate)).not.toThrow()
    expect(isConversationReplacementEvent(event({ surfaceOp: 'append', conversationOp: candidate.conversationOp }))).toBe(false)
    expect(isConversationReplacementEvent({ ...candidate, type: 'turn/start' } as SessionEvent)).toBe(false)
  })

  it('rejects unsupported replacement metadata before commit', () => {
    const log: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } } as SessionEvent,
      event({ seq: SessionSeq(1), conversationOp: undefined }),
    ]
    expect(() => validateConversationEvent(log, event())).not.toThrow()
    expect(() => validateConversationEvent(log, event({
      type: 'turn/start', conversationOp: { op: 'replace', start: 0, end: 1 },
    }))).toThrow(/cannot carry/)
    expect(() => validateConversationEvent(log, event({ surfaceOp: 'append', conversationOp: { op: 'replace', start: 0, end: 1 } }))).toThrow(/replacement surfaceOp/)
    expect(() => validateConversationEvent(log, event({ surfaceOp: undefined, conversationOp: { op: 'replace', start: 0, end: 1 } }))).toThrow(/replacement surfaceOp/)

    for (const conversationOp of [
      null,
      [],
      { op: 'replace', start: 0 },
      { op: 'append', start: 0, end: 1 },
    ]) {
      expect(() => validateConversationEvent(log, event({ conversationOp }))).toThrow(/exact replace operation/)
    }
    for (const conversationOp of [
      { op: 'replace', start: -1, end: 1 },
      { op: 'replace', start: Number.NaN, end: 1 },
      { op: 'replace', start: 0, end: Number.NaN },
      { op: 'replace', start: 2, end: 1 },
    ]) {
      expect(() => validateConversationEvent(log, event({ conversationOp }))).toThrow(/non-negative safe start/)
    }
    expect(() => validateConversationEvent(log, event({ conversationOp: { op: 'replace', start: 0, end: 2 } }))).toThrow(/existing earlier/)
    expect(() => validateConversationEvent([], event({
      conversationOp: { op: 'replace', start: 0, end: 1 },
    }))).toThrow(/existing earlier/)
  })

  it('folds hidden raw ranges with binary-search visibility checks', () => {
    const hiddenRanges = [
      { start: SessionSeq(2), end: SessionSeq(4) },
      { start: SessionSeq(8), end: SessionSeq(10) },
    ]
    expect(isConversationSeqVisible(0, hiddenRanges)).toBe(true)
    expect(isConversationSeqVisible(3, hiddenRanges)).toBe(false)
    expect(isConversationSeqVisible(6, hiddenRanges)).toBe(true)
    expect(isConversationSeqVisible(9, hiddenRanges)).toBe(false)
    expect(isConversationSeqVisible(12, hiddenRanges)).toBe(true)
    expect(isConversationSeqVisible(0, [])).toBe(true)
  })
})
