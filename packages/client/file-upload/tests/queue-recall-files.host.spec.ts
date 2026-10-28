import assert from 'node:assert/strict'
import { it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { FileUploads } from '../src/index.ts'
import type { StagedAttachment } from '../src/types.ts'

function fixture() {
  const file = { attachmentId: 'file-1', name: 'notes.txt', bytes: 3 }
  const session = { header: {} } as Session
  const otherSession = { header: {} } as Session
  const message = { id: 'pending', source: { kind: 'user' }, content: [{ type: 'file', attachment: file }] }
  const agent = { id: 'session', session, inbox: { nextTurn: [message], nextStep: [] } } as Agent
  let live: Agent | undefined = agent
  let data: number[][] = [[0, 255], [1]]
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('agents', { get: (id: string) => id === agent.id ? live : undefined } as never)
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} } as never)
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  ctx.provide('attachments', {
    readFileStream: async function* () { for (const chunk of data) yield Uint8Array.from(chunk) },
  } as never)
  const service = new FileUploads(ctx)
  return { service, agent, file, message, otherSession,
    disposeAgent: () => { live = undefined }, setData: (value: number[][]) => { data = value } }
}

it('rolls back fresh receipt authority without retiring unrelated committed receipts', () => {
  const { service, agent, file, otherSession } = fixture()
  const attachments = [{ type: 'file', attachment: file }] as readonly StagedAttachment[]
  using first = service.stageRecalled(agent, attachments)
  const retained = first.receiptIds[0]!
  first.commit()
  const second = service.stageRecalled(agent, attachments)
  const removed = second.receiptIds[0]!
  assert.notEqual(retained, removed)
  second[Symbol.dispose]()
  assert.deepEqual(service.resolve(agent, retained), attachments[0])
  assert.equal(service.resolve(agent, removed), undefined)
  assert.equal(service.resolve({ ...agent, session: otherSession }, retained), undefined)
})

it('refuses receipt staging for a disposed Agent', () => {
  const { service, agent, file, disposeAgent } = fixture()
  disposeAgent()
  assert.throws(() => service.stageRecalled(agent, [{ type: 'file', attachment: file }] as readonly StagedAttachment[]))
})

it('reads only a file belonging to the exact pending user occurrence', async () => {
  const { service, agent } = fixture()
  const signal = new AbortController().signal
  for (const itemId of ['missing', 'already-running']) {
    await assert.rejects(service.readQueuedFile({ sessionId: agent.id, itemId, attachmentId: 'file-1', signal } as Parameters<FileUploads['readQueuedFile']>[0]))
  }
  await assert.rejects(service.readQueuedFile({ sessionId: agent.id, itemId: 'pending', attachmentId: 'foreign-file', signal } as Parameters<FileUploads['readQueuedFile']>[0]))
  const result = await service.readQueuedFile({ sessionId: agent.id, itemId: 'pending', attachmentId: 'file-1', signal } as Parameters<FileUploads['readQueuedFile']>[0])
  const chunks = []
  for await (const chunk of result.data) chunks.push(...chunk)
  assert.deepEqual(chunks, [0, 255, 1])
})

for (const data of [[[0]], [[0, 1, 2, 3]]]) {
  it(`rejects mismatched stored length ${data[0]?.length} without changing the queue`, async () => {
    const { service, agent, setData } = fixture(); setData(data)
    const result = await service.readQueuedFile({ sessionId: agent.id, itemId: 'pending', attachmentId: 'file-1', signal: new AbortController().signal } as Parameters<FileUploads['readQueuedFile']>[0])
    await assert.rejects(async () => { for await (const _chunk of result.data) { /* drain verifies final integrity */ } })
    assert.equal(agent.inbox.nextTurn.length, 1)
  })
}

it('stops a prepared stream when its Agent is disposed or its caller cancels', async () => {
  for (const kind of ['dispose', 'abort']) {
    const { service, agent, disposeAgent } = fixture(); const abort = new AbortController()
    const result = await service.readQueuedFile({ sessionId: agent.id, itemId: 'pending', attachmentId: 'file-1', signal: abort.signal } as Parameters<FileUploads['readQueuedFile']>[0])
    if (kind === 'dispose') disposeAgent(); else abort.abort()
    await assert.rejects(async () => { for await (const _chunk of result.data) { /* drain */ } })
  }
})

it('reads recalled bytes only through the exact durable operation resolver and revokes it on disposal', async () => {
  const { service, agent, message } = fixture()
  const dispose = service.registerRecallResolver((owner, id, operation) =>
    owner === agent && id === message.id && operation === 'recovered'
      ? message as import('@deepseek-ai/dsh-session').UserMessage : undefined)
  const input = { sessionId: agent.id, itemId: 'pending', attachmentId: 'file-1', recallRequestId: 'recovered',
    signal: new AbortController().signal } as Parameters<FileUploads['readQueuedFile']>[0]
  const read = await service.readQueuedFile(input)
  const bytes = []
  for await (const chunk of read.data) bytes.push(...chunk)
  assert.deepEqual(bytes, [0, 255, 1])
  // An operation token never falls back to a coincidentally still-pending item.
  await assert.rejects(service.readQueuedFile({ ...input, recallRequestId: 'wrong' } as typeof input))
  await assert.rejects(service.readQueuedFile({ ...input, itemId: 'other' } as typeof input))
  dispose()
  await assert.rejects(service.readQueuedFile(input))
})
