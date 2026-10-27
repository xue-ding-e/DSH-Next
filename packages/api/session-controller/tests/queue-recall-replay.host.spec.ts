import assert from 'node:assert/strict'
import { it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '../src/types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReactLoopInbox, inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop/src/inbox.ts'
import { queueRecallProjection } from '../src/queue-recall-projection.ts'

it('replays the atomic removal and recovery content through the unchanged Session reader after JSON storage', () => {
  const session = Session.create(SessionId('recall-replay'))
  const state = () => session.snapshotEvents().reduce((value, event) => inboxProjectionDefinition.apply(value, event), inboxProjectionDefinition.init())
  let observed = 0
  const dispatch = { emit: (name: string) => {
    if (name === 'agent/inbox/discarded') {
      observed++
      assert.equal(session.snapshotEvents().at(-1)?.type, 'agent/inbox/spliced')
    }
  } } as AgentEventDispatch
  const inbox = new ReactLoopInbox(state, session, dispatch)
  const message = createUserMessage({ content: [{ type: 'text', text: 'recover after restart' }], source: { kind: 'user' } })
  inbox.append('next-turn', message)
  const before = session.snapshotEvents().length
  assert.equal(inbox.recall(message.id, brandString<SessionRequestId>('replay-request')), true)
  assert.equal(session.snapshotEvents().length, before + 1)
  assert.equal(observed, 1)
  assert.equal(inbox.nextTurn.length, 0)
  const restored = Session.create(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())), session.header)
  const recovered = restored.snapshotEvents().reduce((value, event) => queueRecallProjection.apply(value, event),
    queueRecallProjection.init(restored.header, restored.inheritedEventCount))
  assert.deepEqual(recovered.recalls[0]?.message, message)
  const pending = restored.snapshotEvents().reduce((value, event) => inboxProjectionDefinition.apply(value, event), inboxProjectionDefinition.init())
  assert.deepEqual(pending['next-turn'], [])
})
