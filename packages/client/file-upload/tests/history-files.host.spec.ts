import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, type Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SessionStore, type UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { FileUploads } from '../src/index.ts'

const FILE: FileAttachmentRef = { attachmentId: AttachmentId('history-file'), name: 'report.csv', bytes: 3 }
const MESSAGE: UserMessage = {
  id: MessageId('human-with-file'), role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: 'Original request' }, { type: 'file', attachment: FILE }],
}

/** Keep the real observation reader; a full-text search is outside this fixture. */
class HistoryQuery extends SessionQueryEngine {
  searchSessions(): never { throw new Error('unexpected full-text Session search') }
  searchEvents(): never { throw new Error('unexpected full-text event search') }
}

function agentFor(ctx: Context, session: Session): Agent {
  const unexpected = (): never => { throw new Error('history restaging must not mutate an Agent') }
  const options = { provider: 'fixture', model: 'fixture' }
  return {
    id: session.id, session, ctx, status: 'idle', options,
    model: new AgentModel(() => ({ lastUsed: null, pending: null }), session, options),
    inbox: { nextTurn: [], nextStep: [], append: unexpected, prepend: unexpected, clear: unexpected,
      replace: unexpected, remove: unexpected, recall: unexpected, splice: unexpected },
    whenIdle: unexpected, runMaintenance: unexpected, send: unexpected, inject: unexpected,
    steer: unexpected, followup: unexpected, cancel: unexpected,
  }
}

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const sessions = new SessionStore(ctx)
  const query = new HistoryQuery(ctx)
  const source = sessions.create(SessionId('source'))
  source.append('user/message', MESSAGE, { surfaceOp: 'append' })
  source.append('user/message', { ...MESSAGE, id: MessageId('other-message'), content: [{ type: 'text', text: 'No file' }] }, { surfaceOp: 'append' })
  source.append('user/message', { ...MESSAGE, id: MessageId('injected'), source: { kind: 'system-prompt' } }, { surfaceOp: 'append' })
  const target = agentFor(ctx, sessions.create(SessionId('child')))
  const sourceAgent = agentFor(ctx, source)
  const live = new Map([[target.id, target], [sourceAgent.id, sourceAgent]])
  ctx.provide('agents', { get: (id: SessionId) => live.get(id) } satisfies Pick<Context['agents'], 'get'>)
  const unregister = vi.fn()
  ctx.provide('commands', { registerFileReceiptResolver: () => unregister } satisfies Pick<Context['commands'], 'registerFileReceiptResolver'>)
  ctx.provide('connection', { fetch: { register: () => unregister } satisfies Pick<Context['connection']['fetch'], 'register'> })
  const service = new FileUploads(ctx)
  const request = { sourceSessionId: source.id, messageId: MESSAGE.id, contentIndex: 1, attachmentId: FILE.attachmentId }
  return { ctx, sessions, query, source, target, sourceAgent, live, service, request }
}

describe('history-authorized file restaging', () => {
  it('mints fresh receipts for the child only and leaves the source log and inbox unchanged', async () => {
    const f = fixture()
    using before = await f.query.observeSession(f.source.id, { projectionMode: 'none' })
    const original = JSON.stringify(before.events)
    const first = await f.service.stageHistory(f.target, f.request, new AbortController().signal)
    const second = await f.service.stageHistory(f.target, f.request, new AbortController().signal)
    expect(first.file).toEqual(FILE)
    expect(second.receiptId).not.toBe(first.receiptId)
    expect(f.service.resolve(f.target, first.receiptId)).toEqual({ type: 'file', attachment: FILE })
    expect(f.service.resolve(f.sourceAgent, first.receiptId)).toBeUndefined()
    expect(f.service.resolve({ ...f.target, session: Session.create(f.target.id) }, first.receiptId)).toBeUndefined()
    using binding = f.service.bindPrompt(f.target, [first.receiptId], 'child-prompt')
    binding.commit()
    f.service.retirePrompt(f.target, 'child-prompt')
    expect(f.service.resolve(f.target, first.receiptId)).toBeUndefined()
    expect(f.service.resolve(f.target, second.receiptId)).toBeDefined()
    using after = await f.query.observeSession(f.source.id, { projectionMode: 'none' })
    expect(JSON.stringify(after.events)).toBe(original)
    expect(f.sourceAgent.inbox.nextTurn).toEqual([])
    expect(f.target.inbox.nextTurn).toEqual([])
  })

  it('declares both source and receiving Sessions for Remote access checks', () => {
    const f = fixture()
    const reader = remoteMethods(f.service).find(method => method.method === 'stageHistory')?.resources?.session
    expect(reader).toBeDefined()
    expect(reader!(f.target.id, f.request, new AbortController().signal)).toEqual([f.target.id, f.source.id])
  })

  it('preserves distinct stored names when one human message repeats the same file bytes', async () => {
    const f = fixture()
    const renamed = { ...FILE, name: 'second-report.csv' }
    const repeated = { ...MESSAGE, id: MessageId('repeated-file'), content: [
      { type: 'file' as const, attachment: FILE }, { type: 'file' as const, attachment: renamed },
    ] }
    f.source.append('user/message', repeated, { surfaceOp: 'append' })
    const signal = new AbortController().signal
    const first = await f.service.stageHistory(f.target, { ...f.request, messageId: repeated.id, contentIndex: 0 }, signal)
    const second = await f.service.stageHistory(f.target, { ...f.request, messageId: repeated.id, contentIndex: 1 }, signal)
    expect(first.file).toEqual(FILE)
    expect(second.file).toEqual(renamed)
    expect(first.receiptId).not.toBe(second.receiptId)
  })

  it('rejects another Session, the wrong message, a different attachment, and non-human input', async () => {
    const f = fixture()
    const other = f.sessions.create(SessionId('unrelated'))
    for (const request of [
      { ...f.request, sourceSessionId: other.id },
      { ...f.request, sourceSessionId: SessionId('missing') },
      { ...f.request, messageId: MessageId('missing') },
      { ...f.request, messageId: MessageId('other-message') },
      { ...f.request, messageId: MessageId('injected') },
      { ...f.request, attachmentId: AttachmentId('different-file') },
      { ...f.request, contentIndex: 0 },
      { ...f.request, contentIndex: 9 },
      { ...f.request, contentIndex: -1 },
      { ...f.request, contentIndex: 0.5 },
    ]) {
      await expect(f.service.stageHistory(f.target, request, new AbortController().signal)).rejects.toThrow()
    }
    await expect(f.service.readQueuedFile({ sessionId: f.source.id, itemId: MESSAGE.id,
      attachmentId: FILE.attachmentId, signal: new AbortController().signal })).rejects.toThrow('pending user occurrence')
  })

  it('releases its observation after both successful staging and authorization refusal', async () => {
    const f = fixture()
    const observe = f.query.observeSession.bind(f.query)
    const released = vi.fn()
    const spy = vi.spyOn(f.query, 'observeSession').mockImplementation(async (id, options) => {
      const source = await observe(id, options)
      return { ...source, [Symbol.dispose]: () => { source[Symbol.dispose](); released() } }
    })
    onTestFinished(() => { spy.mockRestore() })
    const signal = new AbortController().signal
    await f.service.stageHistory(f.target, f.request, signal)
    await expect(f.service.stageHistory(f.target, { ...f.request, messageId: MessageId('missing') }, signal)).rejects.toThrow()
    expect(spy).toHaveBeenCalledWith(f.source.id, { projectionMode: 'none', signal })
    expect(released).toHaveBeenCalledTimes(2)
  })

  it.each(['cancel', 'dispose', 'replace'] as const)('grants no receipt after %s during source observation', async (kind) => {
    const f = fixture()
    const ready = Promise.withResolvers<SessionObservation>()
    const source = await f.query.observeSession(f.source.id, { projectionMode: 'none' })
    const released = vi.fn(() => { source[Symbol.dispose]() })
    const spy = vi.spyOn(f.query, 'observeSession').mockReturnValueOnce(ready.promise)
    onTestFinished(() => { spy.mockRestore() })
    const controller = new AbortController()
    const pending = f.service.stageHistory(f.target, f.request, controller.signal)
    if (kind === 'cancel') controller.abort()
    else if (kind === 'dispose') f.live.delete(f.target.id)
    else f.live.set(f.target.id, agentFor(f.ctx, Session.create(f.target.id)))
    ready.resolve({ ...source, [Symbol.dispose]: released })
    await expect(pending).rejects.toThrow()
    expect(released).toHaveBeenCalledOnce()
  })

  it('rejects cancelled requests and subagent targets before reading history', async () => {
    const f = fixture()
    const spy = vi.spyOn(f.query, 'observeSession')
    onTestFinished(() => { spy.mockRestore() })
    await expect(f.service.stageHistory(f.target, f.request, AbortSignal.abort())).rejects.toThrow()
    const subagent = agentFor(f.ctx, Session.create(SessionId('subagent'), undefined,
      { ...f.target.session.header, id: SessionId('subagent'), origin: 'subagent' }))
    await expect(f.service.stageHistory(subagent, f.request, new AbortController().signal)).rejects.toMatchObject({ code: 'subagent/attachment-invalid' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('revokes staged authority when its target Session is disposed', async () => {
    const f = fixture()
    const staged = await f.service.stageHistory(f.target, f.request, new AbortController().signal)
    f.ctx.emit('session/disposed', f.target.session)
    expect(f.service.resolve(f.target, staged.receiptId)).toBeUndefined()
  })
})
