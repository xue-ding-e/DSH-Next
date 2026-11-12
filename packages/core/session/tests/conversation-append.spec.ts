import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, type SurfaceIntent } from '@deepseek-ai/dsh-session'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('conversation metadata across Session append overloads', () => {
  it.each(['single', 'batch'] as const)('snapshots and restores conversation metadata from a %s append', (mode) => {
    const session = Session.create(SessionId(`conversation-${mode}`))
    session.append('user/message', message('original'), { surfaceOp: 'append' })
    const conversationOp = { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(0) }
    let reads = 0
    const intent: SurfaceIntent<'user/message'> = {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
      sourceEventSeqs: [SessionSeq(0)],
      get conversationOp() {
        reads++
        return conversationOp
      },
    }
    const replacement = message('replacement')
    const event = mode === 'single'
      ? session.append('user/message', replacement, intent)
      : session.append([['user/message', replacement, intent]])[0]
    conversationOp.end = SessionSeq(9)

    expect(reads).toBe(1)
    expect(event?.conversationOp).toEqual({ op: 'replace', start: 0, end: 0 })
    expect(Object.isFrozen(event?.conversationOp)).toBe(true)
    expect(session.deriveMessages()).toEqual([replacement])
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(restored.snapshotEvents().slice(0, session.seq)).toEqual(session.snapshotEvents())
    expect(restored.snapshotEvents().at(-1)).toMatchObject({ type: 'session/end-seed', seq: session.seq })
    expect(restored.deriveMessages()).toEqual([replacement])
  })

  it('accepts raw ranges spanning committed history and earlier batch members', () => {
    const session = Session.create(SessionId('conversation-batch-prefix'))
    session.append('user/message', message('before batch'), { surfaceOp: 'append' })
    const replacement = message('replacement')
    const events = session.append([
      ['user/message', message('first member'), { surfaceOp: 'append' }],
      ['user/message', replacement, {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) },
        sourceEventSeqs: [SessionSeq(0), SessionSeq(1)],
        conversationOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(1) },
      }],
    ])

    expect(events.map(event => event.seq)).toEqual([1, 2])
    expect(events[1]?.conversationOp).toEqual({ op: 'replace', start: 0, end: 1 })
    expect(session.surface.nodes).toEqual([2])
    expect(session.deriveMessages()).toEqual([replacement])
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(restored.deriveMessages()).toEqual([replacement])
  })

  it.each([
    { label: 'first member references a future member', firstEnd: 2, lastEnd: 1 },
    { label: 'last member references itself', firstEnd: 0, lastEnd: 2 },
  ])('rejects the whole batch when $label', async ({ firstEnd, lastEnd }) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('conversation-invalid-batch'))
    session.append('user/message', message('original'), { surfaceOp: 'append' })
    const before = session.snapshotEvents()
    const beforeMessages = session.deriveMessages()
    const beforeGeneration = session.surface.contentGeneration
    const observed: number[] = []
    ctx.on('session/event', (current, event) => {
      if (current === session) observed.push(event.seq)
    })

    expect(() => session.append([
      ['user/message', message('first replacement'), {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
        sourceEventSeqs: [SessionSeq(0)],
        conversationOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(firstEnd) },
      }],
      ['user/message', message('last replacement'), {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
        sourceEventSeqs: [SessionSeq(1)],
        conversationOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(lastEnd) },
      }],
    ])).toThrow(/existing earlier event range/)

    expect(session.seq).toBe(1)
    expect(session.snapshotEvents()).toBe(before)
    expect(session.surface.nodes).toEqual([0])
    expect(session.surface.contentGeneration).toBe(beforeGeneration)
    expect(session.deriveMessages()).toEqual(beforeMessages)
    expect(observed).toEqual([])
    expect(session.currentBatchPublication).toBeUndefined()
  })

  it.each(['single', 'batch'] as const)('rejects conversation replacement on append surface in the %s overload', (mode) => {
    const session = Session.create(SessionId(`conversation-invalid-${mode}`))
    session.append('user/message', message('original'), { surfaceOp: 'append' })
    const replacement = message('invalid')
    const intent: SurfaceIntent<'user/message'> = {
      surfaceOp: 'append',
      conversationOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(0) },
    }
    expect(() => {
      if (mode === 'single') session.append('user/message', replacement, intent)
      else session.append([['user/message', replacement, intent]])
    }).toThrow(/replacement surfaceOp/)
    expect(session.seq).toBe(1)
    expect(session.surface.nodes).toEqual([0])
  })
})
