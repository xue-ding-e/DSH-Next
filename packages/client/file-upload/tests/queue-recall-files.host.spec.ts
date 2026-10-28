import assert from 'node:assert/strict'
import { it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, type Agent, type Inbox } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { FileUploads } from '../src/index.ts'
import type { StagedAttachment } from '../src/types.ts'

function fixture() {
  const file: FileAttachmentRef = { attachmentId: AttachmentId('file-1'), name: 'notes.txt', bytes: 3 }
  const session = Session.create(SessionId('session'))
  const otherSession = Session.create(session.id)
  const message: UserMessage = { id: MessageId('pending'), role: 'user', source: { kind: 'user' },
    content: [{ type: 'file', attachment: file }] }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  // File reads and receipt staging must not wake a driver or mutate the pending queue.
  const unexpected = (): never => { throw new Error('unexpected Agent or Inbox mutation') }
  const inbox: Inbox = {
    nextTurn: [message], nextStep: [], clear: unexpected, append: unexpected, prepend: unexpected,
    replace: unexpected, remove: unexpected, recall: unexpected, splice: unexpected,
  }
  const options = { provider: 'fixture', model: 'fixture-model' }
  const agent: Agent = {
    id: session.id, session, inbox, options, ctx, status: 'idle',
    model: new AgentModel(() => ({ lastUsed: null, pending: null }), session, options),
    whenIdle: async () => {}, runMaintenance: unexpected, send: unexpected, inject: unexpected,
    steer: unexpected, followup: unexpected, cancel: unexpected,
  }
  let live: Agent | undefined = agent
  let data: number[][] = [[0, 255], [1]]
  ctx.provide('agents', { get: (id: string) => id === agent.id ? live : undefined } satisfies Pick<Context['agents'], 'get'>)
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} } satisfies Pick<Context['commands'], 'registerFileReceiptResolver'>)
  ctx.provide('connection', { fetch: { register: () => async () => {} } satisfies Pick<Context['connection']['fetch'], 'register'> })
  ctx.provide('attachments', {
    readFileStream: async function* () { for (const chunk of data) yield Uint8Array.from(chunk) },
  } satisfies Pick<Context['attachments'], 'readFileStream'>)
  const service = new FileUploads(ctx)
  return { service, agent, file, message, otherSession,
    disposeAgent: () => { live = undefined }, setData: (value: number[][]) => { data = value } }
}

it('rolls back fresh receipt authority without retiring unrelated committed receipts', () => {
  const { service, agent, file, otherSession } = fixture()
  const attachments: readonly StagedAttachment[] = [{ type: 'file', attachment: file }]
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
  assert.throws(() => service.stageRecalled(agent, [{ type: 'file', attachment: file }]))
})

it('reads only a file belonging to the exact pending user occurrence', async () => {
  const { service, agent } = fixture()
  const signal = new AbortController().signal
  for (const itemId of ['missing', 'already-running']) {
    await assert.rejects(service.readQueuedFile({ sessionId: agent.id, itemId: MessageId(itemId), attachmentId: AttachmentId('file-1'), signal }))
  }
  await assert.rejects(service.readQueuedFile({ sessionId: agent.id, itemId: MessageId('pending'), attachmentId: AttachmentId('foreign-file'), signal }))
  const result = await service.readQueuedFile({ sessionId: agent.id, itemId: MessageId('pending'), attachmentId: AttachmentId('file-1'), signal })
  const chunks = []
  for await (const chunk of result.data) chunks.push(...chunk)
  assert.deepEqual(chunks, [0, 255, 1])
})

for (const data of [[[0]], [[0, 1, 2, 3]]]) {
  it(`rejects mismatched stored length ${data[0]?.length} without changing the queue`, async () => {
    const { service, agent, setData } = fixture(); setData(data)
    const result = await service.readQueuedFile({ sessionId: agent.id, itemId: MessageId('pending'), attachmentId: AttachmentId('file-1'), signal: new AbortController().signal })
    await assert.rejects(async () => { for await (const _chunk of result.data) { /* drain verifies final integrity */ } })
    assert.equal(agent.inbox.nextTurn.length, 1)
  })
}

it('stops a prepared stream when its Agent is disposed or its caller cancels', async () => {
  for (const kind of ['dispose', 'abort']) {
    const { service, agent, disposeAgent } = fixture(); const abort = new AbortController()
    const result = await service.readQueuedFile({ sessionId: agent.id, itemId: MessageId('pending'), attachmentId: AttachmentId('file-1'), signal: abort.signal })
    if (kind === 'dispose') disposeAgent(); else abort.abort()
    await assert.rejects(async () => { for await (const _chunk of result.data) { /* drain */ } })
  }
})

it('reads recalled bytes only through the exact durable operation resolver and revokes it on disposal', async () => {
  const { service, agent, message } = fixture()
  const dispose = service.registerRecallResolver((owner, id, operation) =>
    owner === agent && id === message.id && operation === 'recovered'
      ? message : undefined)
  const input = { sessionId: agent.id, itemId: MessageId('pending'), attachmentId: AttachmentId('file-1'), recallRequestId: brandString<Branded<'session-request-id'>>('recovered'),
    signal: new AbortController().signal }
  const read = await service.readQueuedFile(input)
  const bytes = []
  for await (const chunk of read.data) bytes.push(...chunk)
  assert.deepEqual(bytes, [0, 255, 1])
  // An operation token never falls back to a coincidentally still-pending item.
  await assert.rejects(service.readQueuedFile({ ...input, recallRequestId: brandString<Branded<'session-request-id'>>('wrong') }))
  await assert.rejects(service.readQueuedFile({ ...input, itemId: MessageId('other') }))
  dispose()
  await assert.rejects(service.readQueuedFile(input))
})
