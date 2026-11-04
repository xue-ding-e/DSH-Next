import { describe, expect, it, vi } from 'vitest'
import type {
  ChatConversationViewNode, ChatNodeSource,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

const timeline: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }

function userNode(index: number, text = `message ${String(index)}`): ChatConversationViewNode {
  return {
    key: `user:${String(index)}`,
    id: String(index),
    target: 'chat',
    kind: 'user',
    anchorSeq: index,
    location: { kind: 'session' },
    visibility: 'visible',
    data: {
      kind: 'user',
      messageId: `message-${String(index)}`,
      seq: index,
      time: index,
      content: [{ type: 'text', text }],
      source: null,
    },
  }
}

describe('Chat Node keyed sources', () => {
  it('publishes an identity change even when the recall label stays equal and reuses equivalent message facts', () => {
    const builder = new ChatSnapshotBuilder()
    const user = userNode(1, '@Same title')
    const recall = (sessionId: string): ChatConversationViewNode => ({
      key: 'recall:2', kind: 'context', id: '2', target: 'chat', anchorSeq: 2,
      location: { kind: 'session' }, visibility: 'visible',
      data: { kind: 'context', seq: 2, time: 2, content: [], source: {
        kind: 'session-reference', form: 'recall', references: [{ sessionId, label: 'Same title' }],
      } },
    })
    const initial = builder.replace({ nodes: [user, recall('source-a')], timeline })
    builder.publish()
    const source = initial.nodes.source(user.key)
    const changed = vi.fn()
    source.subscribe(changed)
    builder.apply({ upserts: [recall('source-b')], timeline })
    builder.publish()
    expect(source.getSnapshot()?.data).toMatchObject({ sessionReferences: [{ sessionId: 'source-b', label: 'Same title' }] })
    expect(changed).toHaveBeenCalledOnce()
    const accepted = source.getSnapshot()
    builder.apply({ upserts: [recall('source-b')], timeline })
    builder.publish()
    expect(source.getSnapshot()).toBe(accepted)
    expect(changed).toHaveBeenCalledOnce()
    builder.apply({ upserts: [{ ...recall('source-b'), data: {
      kind: 'context', seq: 2, time: 2, content: [], source: { kind: 'notice', form: 'notice' },
    } }], timeline })
    builder.publish()
    expect(source.getSnapshot()?.data).not.toHaveProperty('sessionReferences')
  })

  it('provides ordered projected Nodes and previous values to grouping', () => {
    const builder = new ChatSnapshotBuilder()
    const user = userNode(1)
    const snapshot = builder.replace({ nodes: [user], timeline })
    const initial = builder.groupInput()
    expect(initial.kind).toBe('replace')
    expect(initial.order).toBe(snapshot.order)
    expect(initial.readNode(initial.order[0]!)).toBe(user)
    expect(initial.readPosition(initial.order[0]!)).toEqual({ turn: undefined, previous: undefined, next: undefined })
    expect(initial.readTurn(7)).toEqual([])
    const context: ChatConversationViewNode = {
      key: 'context:2', kind: 'context', id: '2', target: 'chat', anchorSeq: 2,
      location: { kind: 'session' }, visibility: 'visible',
      data: {
        kind: 'context', seq: 2, time: 2, content: [],
        source: { kind: 'skill-invocation', name: 'demo', form: 'instructions' },
      },
    }
    const next = builder.apply({ upserts: [context], timeline, changedTurns: [7] })
    const input = builder.groupInput()
    if (input.kind !== 'apply') throw new Error('expected apply')
    expect(input.order).toBe(next.order)
    expect(input.changedTurns).toEqual([7])
    expect(input.changedTurnOrders).toEqual([])
    expect(input.readPosition(context.key as typeof input.order[number])).toEqual({ turn: undefined, previous: user.key, next: undefined })
    expect(input.readPosition('missing' as typeof input.order[number])).toBeUndefined()
    expect(input.changes.find(change => change.current.key === user.key)).toEqual({
      previous: user, current: next.nodes.get(user.key),
    })
    expect(next.nodes.get(user.key)?.data).toMatchObject({ skillNames: ['demo'] })
    expect(input.changes.find(change => change.current.key === context.key)).toEqual({ previous: undefined, current: context })
    builder.apply({ upserts: [], timeline })
    expect(builder.groupInput()).toMatchObject({ kind: 'apply', changes: [], changedTurns: [], changedTurnOrders: [] })
    expect(builder.groupInput().order).toBe(next.order)
  })

  it('notifies only the updated key among 4,000 mounted sources', () => {
    const builder = new ChatSnapshotBuilder()
    const nodes = Array.from({ length: 4_000 }, (_, index) => userNode(index + 1))
    const initial = builder.replace({ nodes, timeline })
    const listeners = nodes.map(() => vi.fn())
    const sources: ChatNodeSource[] = nodes.map((node, index) => {
      const source = initial.nodes.source(node.key)
      source.subscribe(listeners[index]!)
      return source
    })

    const target = 2_347
    const changed = userNode(target + 1, 'streamed update')
    const next = builder.apply({ upserts: [changed], timeline })

    expect(listeners[target]).not.toHaveBeenCalled()
    builder.publish()

    expect(listeners[target]).toHaveBeenCalledOnce()
    expect(listeners.reduce((count, listener) => count + listener.mock.calls.length, 0)).toBe(1)
    expect(next.nodes.source(changed.key)).toBe(sources[target])
    expect(next.nodes.get(changed.key)).toBe(changed)
  })
})
