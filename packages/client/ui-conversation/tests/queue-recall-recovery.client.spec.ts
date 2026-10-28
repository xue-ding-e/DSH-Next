// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { QueueRecall } from '../src/client/queue/recall.ts'
import { RecallJournal } from '../src/client/queue/recall-journal.ts'

const message = { id: 'message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'recover me' }] }
const accepted = { ok: true, value: { accepted: true, recalled: { content: message.content, attachments: [] } } }

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('unfinished recall recovery', () => {
  it('discovers only persisted identities after reload and recovers without reenqueuing input', async () => {
    let rows = [message]
    const updateQueue = vi.fn(async () => {
      rows = []
      throw new Error('response lost after durable recall')
    })
    const session = { sessionId: 'session', getSnapshot: () => ({ pendingSubmissions: [] }),
      projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': rows, 'next-step': [] }) }) }, updateQueue }
    const prepare = vi.fn(async () => [])
    const first = new QueueRecall(prepare, () => {}, () => 'operation' as SessionRequestId)
    await expect(first.recall(session as never, () => true)).rejects.toThrow('response lost')
    const journal = localStorage.getItem('dsh.conversation.recall/session/operation')
    expect(JSON.parse(journal!)).toEqual({ version: 1, itemId: 'message', requestId: 'operation' })
    expect(journal).not.toContain('recover me')
    updateQueue.mockResolvedValue(accepted as never)
    const reloaded = new QueueRecall(prepare, () => {}, () => { throw new Error('must reuse the saved identity') })
    expect(reloaded.available(session as never)).toBe(true)
    const result = await reloaded.recall(session as never, () => true)
    expect(updateQueue).toHaveBeenNthCalledWith(2, 'message', { kind: 'recover-recall', requestId: 'operation' })
    expect(updateQueue).toHaveBeenNthCalledWith(3, 'message', {
      kind: 'recall', requestId: 'operation', expectedContent: message.content,
    })
    expect(prepare).toHaveBeenLastCalledWith(session, expect.objectContaining({ id: 'message' }), undefined, 'operation')
    result!.commit()
    expect(localStorage.length).toBe(0)
  })

  it('cannot remove a message when pending-operation storage fails', async () => {
    const updateQueue = vi.fn()
    const session = { sessionId: 'session', getSnapshot: () => ({ pendingSubmissions: [] }),
      projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [message], 'next-step': [] }) }) }, updateQueue }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    const release = vi.fn()
    const recall = new QueueRecall(async () => ['prepared'], release, () => 'operation' as SessionRequestId)
    await expect(recall.recall(session as never, () => true)).rejects.toThrow('storage unavailable')
    expect(updateQueue).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(['prepared'])
  })

  it('separates operation records so another browser tab cannot overwrite or clear their identity', () => {
    const journal = new RecallJournal()
    const first = { itemId: 'first' as never, requestId: 'a' as SessionRequestId }
    const second = { itemId: 'second' as never, requestId: 'b' as SessionRequestId }
    journal.write('session' as never, first)
    journal.write('session' as never, second)
    journal.clear('session' as never, first)
    expect(journal.read('session' as never)).toEqual(second)
    expect(journal.read('other-session' as never)).toBeUndefined()
  })
})
