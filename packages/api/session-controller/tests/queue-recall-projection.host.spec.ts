import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { queueRecallProjection, type QueueRecallState } from '../src/queue-recall-projection.ts'

const event = (seq: number, id = 'request-1'): SessionEvent => ({
  seq, time: 1, type: 'agent/inbox/spliced', data: {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    recall: { requestId: id, message: { id: 'message-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'recover after restart' }] } },
  },
} as SessionEvent)
const empty = (): QueueRecallState => ({ ownStart: 0, recalls: [] })

it('rebuilds the exact recoverable handoff from JSON after a Host restart', () => {
  const persisted: SessionEvent = JSON.parse(JSON.stringify(event(1)))
  const first = queueRecallProjection.apply(empty(), persisted)
  const restarted = queueRecallProjection.apply(empty(), persisted)
  assert.deepEqual(restarted, first)
  assert.equal(restarted.recalls[0]?.requestId, 'request-1')
  assert.deepEqual(restarted.recalls[0]?.message.content, [{ type: 'text', text: 'recover after restart' }])
})

it('does not inherit another Session recall authority through a fork prefix', () => {
  const state = queueRecallProjection.init({} as SessionHeader, 3 as SessionLogOffset)
  assert.equal(queueRecallProjection.apply(state, event(2)), state)
  assert.equal(queueRecallProjection.apply(state, event(3)).recalls.length, 1)
})

it('rejects duplicate request identity rather than replacing its recovered occurrence', () => {
  const first = queueRecallProjection.apply(empty(), event(1))
  assert.throws(() => queueRecallProjection.apply(first, event(2)), /invalid persisted/)
})

it('leaves old ordinary cancellation events unchanged', () => {
  const value = event(1)
  assert.equal(value.type, 'agent/inbox/spliced')
  if (value.type !== 'agent/inbox/spliced') throw new Error('fixture')
  const { recall: _recall, ...data } = value.data
  const state = empty()
  assert.equal(queueRecallProjection.apply(state, { ...value, data }), state)
})
