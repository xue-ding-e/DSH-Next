import assert from 'node:assert/strict'
import { it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '../src/types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { recallAgent } from './queue-recall-agent.ts'
import { queueRecallProjection } from '../src/queue-recall-projection.ts'

it('replays the atomic removal and recovery content through the unchanged Session reader after JSON storage', async () => {
  const { ctx, session, inbox } = await recallAgent(Session.create(SessionId('recall-replay')))
  let observed = 0
  let observedEvent: string | undefined
  ctx.on('agent/inbox/discarded', () => {
    observed++
    observedEvent = session.snapshotEvents().at(-1)?.type
  })
  const message = createUserMessage({ content: [{ type: 'text', text: 'recover after restart' }], source: { kind: 'user' } })
  inbox.append('next-turn', message)
  const before = session.snapshotEvents().length
  assert.equal(inbox.recall(message.id, brandString<SessionRequestId>('replay-request')), true)
  assert.equal(session.snapshotEvents().length, before + 1)
  assert.equal(observed, 1)
  assert.equal(observedEvent, 'agent/inbox/spliced')
  assert.equal(inbox.nextTurn.length, 0)
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
  const recovered = restored.snapshotEvents().reduce((value, event) => queueRecallProjection.apply(value, event),
    queueRecallProjection.init(restored.header, restored.inheritedEventCount))
  assert.deepEqual(recovered.recalls[0]?.message, message)
  const replayed = await recallAgent(restored)
  assert.deepEqual(replayed.session.snapshotEvents(), restored.snapshotEvents())
  assert.deepEqual(replayed.inbox.nextTurn, [])
})
