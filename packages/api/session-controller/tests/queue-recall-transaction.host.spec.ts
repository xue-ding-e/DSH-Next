import assert from 'node:assert/strict'
import { it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '../src/types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { recallAgent } from './queue-recall-agent.ts'
import { queueRecallProjection } from '../src/queue-recall-projection.ts'
import { QueueRecallController } from '../src/queue-recall.ts'

async function harness(seed?: readonly SessionEvent[], child = false) {
  const initial = Session.create(SessionId('transaction'))
  const { ctx, agent, session, inbox } = await recallAgent(Session.create(initial.id, seed, child
    ? { ...initial.header, origin: 'subagent', parentSession: SessionId('parent') } : initial.header))
  let throwOnDiscard = false
  let onDiscard: (() => void) | undefined
  ctx.on('agent/inbox/discarded', () => {
    onDiscard?.()
    if (throwOnDiscard) throw new Error('observer failed')
  })
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} } as Context['commands'])
  ctx.provide('connection', { fetch: { register: () => () => {} } } as Context['connection'])
  const files = new FileUploads(ctx)
  const controller = new QueueRecallController()
  const projection = {
    stateOf: () => session.snapshotEvents().reduce((value, event) => queueRecallProjection.apply(value, event),
      queueRecallProjection.init(session.header, session.inheritedEventCount)),
    dispose: async () => {},
  }
  return { session, inbox, agent, files, controller, projection,
    failObserver: () => { throwOnDiscard = true },
    onDiscard: (callback: () => void) => { onDiscard = callback } }
}

const requestId = brandString<SessionRequestId>('transaction-request')
function pending() {
  return createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'one' },
    { type: 'file', attachment: { attachmentId: brandString<import('@deepseek-ai/dsh-attachment').AttachmentId>('file'), name: '中文.txt', bytes: 3 } },
    { type: 'text', text: 'two' },
    { type: 'image', attachment: { attachmentId: brandString<import('@deepseek-ai/dsh-attachment').AttachmentId>('image'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
  ] })
}

it('recovers a lost response after Host restart with fresh receipts and no duplicate queue mutation', async () => {
  const first = await harness(); const message = pending()
  first.inbox.append('next-turn', message)
  const action = { kind: 'recall' as const, requestId, expectedContent: message.content }
  const accepted = first.controller.recall(first.agent, message.id, action, first.projection, first.files)
  assert.deepEqual(accepted.recalled?.content, message.content)
  assert.deepEqual(accepted.recalled?.attachments.map(item => item.type), ['file', 'image'])
  assert.equal(first.inbox.nextTurn.length, 0)
  assert.deepEqual(first.controller.recall(first.agent, message.id, action, first.projection, first.files), accepted)
  const second = await harness(JSON.parse(JSON.stringify(first.session.snapshotEvents())))
  const count = second.session.snapshotEvents().length
  const recovered = second.controller.recall(second.agent, message.id, action, second.projection, second.files)
  assert.deepEqual(recovered.recalled?.content, message.content)
  assert.notEqual(recovered.recalled?.attachments[0]?.receiptId, accepted.recalled?.attachments[0]?.receiptId)
  assert.equal(second.session.snapshotEvents().length, count)
  assert.equal(second.inbox.nextTurn.length, 0)
  const receipt = recovered.recalled?.attachments[0]?.receiptId
  assert(receipt); assert.equal(second.files.resolve(second.agent, receipt)?.type, 'file')
})

it('retains a durably committed response when a discard observer throws', async () => {
  const h = await harness(); const message = pending(); h.inbox.append('next-turn', message); h.failObserver()
  const action = { kind: 'recall' as const, requestId, expectedContent: message.content }
  const result = h.controller.recall(h.agent, message.id, action, h.projection, h.files)
  assert.deepEqual(result.recalled?.content, message.content)
  assert.deepEqual(h.controller.recall(h.agent, message.id, action, h.projection, h.files), result)
  assert.equal(h.inbox.nextTurn.length, 0)
})

it('rejects stale CAS and reused request identity without removing other pending messages', async () => {
  const h = await harness(); const message = pending(); const other = pending()
  h.inbox.append('next-turn', message); h.inbox.append('next-turn', other)
  assert.throws(() => h.controller.recall(h.agent, message.id,
    { kind: 'recall', requestId, expectedContent: [{ type: 'text', text: 'stale' }] }, h.projection, h.files))
  assert.equal(h.inbox.nextTurn.length, 2)
  const action = { kind: 'recall' as const, requestId, expectedContent: message.content }
  h.controller.recall(h.agent, message.id, action, h.projection, h.files)
  assert.throws(() => h.controller.recall(h.agent, other.id, action, h.projection, h.files))
  assert.deepEqual(h.inbox.nextTurn, [other])
})

it('leaves the queue intact on a precommit failure and allows the same request to retry', async () => {
  const h = await harness(); const message = pending(); h.inbox.append('next-turn', message)
  const original = h.inbox.recall.bind(h.inbox)
  const stage = h.files.stageRecalled.bind(h.files)
  let prepared: readonly import('@deepseek-ai/dsh-client-file-upload').FileUploadReceiptId[] = []
  h.files.stageRecalled = (agent, attachments) => {
    const batch = stage(agent, attachments); prepared = batch.receiptIds; return batch
  }
  h.inbox.recall = () => { throw new Error('storage failed before commit') }
  const action = { kind: 'recall' as const, requestId, expectedContent: message.content }
  assert.throws(() => h.controller.recall(h.agent, message.id, action, h.projection, h.files), /storage failed/)
  assert.deepEqual(h.inbox.nextTurn, [message])
  assert.equal(prepared.length, 2)
  for (const receiptId of prepared) assert.equal(h.files.resolve(h.agent, receiptId), undefined)
  h.inbox.recall = original
  assert.deepEqual(h.controller.recall(h.agent, message.id, action, h.projection, h.files).recalled?.content, message.content)
})


it('returns the same staged receipt identities to a reentrant postcommit discard observer', async () => {
  const h = await harness(); const message = pending(); h.inbox.append('next-turn', message)
  const action = { kind: 'recall' as const, requestId, expectedContent: message.content }
  let observed: ReturnType<QueueRecallController['recall']> | undefined
  h.onDiscard(() => { observed = h.controller.recall(h.agent, message.id, action, h.projection, h.files) })
  const result = h.controller.recall(h.agent, message.id, action, h.projection, h.files)
  assert.deepEqual(observed, result)
  assert.equal(h.projection.stateOf().recalls.length, 1)
})

it('does not acknowledge a reentrant call before its durable handoff exists', async () => {
  const h = await harness(); const message = pending(); h.inbox.append('next-turn', message)
  const action = { kind: 'recall' as const, requestId, expectedContent: message.content }
  const original = h.inbox.recall.bind(h.inbox)
  h.inbox.recall = (id, operation) => {
    assert.throws(() => h.controller.recall(h.agent, message.id, action, h.projection, h.files), /has not committed/)
    return original(id, operation)
  }
  const result = h.controller.recall(h.agent, message.id, action, h.projection, h.files)
  assert.deepEqual(result.recalled?.content, message.content)
  assert.equal(h.projection.stateOf().recalls.length, 1)
})

it('recovers after browser reload from only item and request identities without removing other work', async () => {
  const h = await harness(); const message = pending(); const other = pending()
  h.inbox.append('next-turn', message); h.inbox.append('next-turn', other)
  h.controller.recall(h.agent, message.id, { kind: 'recall', requestId, expectedContent: message.content }, h.projection, h.files)
  const restarted = await harness(JSON.parse(JSON.stringify(h.session.snapshotEvents())))
  const before = restarted.session.snapshotEvents().length
  const result = restarted.controller.recover(restarted.agent, message.id, requestId, restarted.projection, restarted.files)
  assert.deepEqual(result.recalled?.content, message.content)
  assert.deepEqual(restarted.inbox.nextTurn, [other])
  assert.equal(restarted.session.snapshotEvents().length, before)
  assert.throws(() => restarted.controller.recover(restarted.agent, other.id, requestId, restarted.projection, restarted.files))
  assert.throws(() => restarted.controller.recover(restarted.agent, message.id, brandString<SessionRequestId>('wrong'), restarted.projection, restarted.files))
})


it('recalls already-authorized child text and images without invoking file receipt services', async () => {
  for (const withImage of [false, true]) {
    const h = await harness(undefined, true)
    h.files.stageRecalled = () => { throw new Error('must not mint child receipts') }
    h.files.retirePrompt = () => { throw new Error('must not touch child receipts') }
    const content = pending().content.filter(part => part.type === 'text' || (withImage && part.type === 'image'))
    const message = createUserMessage({ source: { kind: 'user' }, content })
    h.inbox.append('next-turn', message)
    const result = h.controller.recall(h.agent, message.id,
      { kind: 'recall', requestId, expectedContent: message.content }, h.projection, h.files)
    assert.deepEqual(result.recalled?.content, message.content)
    assert.equal(result.recalled?.attachments.length, withImage ? 1 : 0)
    assert.equal(result.recalled?.attachments[0]?.receiptId, undefined)
    assert.equal(h.inbox.nextTurn.length, 0)
  }
})

it('rejects child generic files before mutation or file staging/read', async () => {
  const h = await harness(undefined, true); const message = pending(); h.inbox.append('next-turn', message)
  h.files.stageRecalled = () => { throw new Error('must not stage') }
  h.files.readQueuedFile = async () => { throw new Error('must not read') }
  assert.throws(() => h.controller.recall(h.agent, message.id,
    { kind: 'recall', requestId, expectedContent: message.content }, h.projection, h.files), /do not accept recalled file/)
  assert.deepEqual(h.inbox.nextTurn, [message])
  assert.equal(h.projection.stateOf().recalls.length, 0)
})
