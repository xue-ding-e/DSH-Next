import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '../src/types.ts'
import type { FileUploadReceiptId, StagedAttachment } from '@deepseek-ai/dsh-client-file-upload/types'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  Session, SessionId, SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { unsupportedModel, createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installSessionReadTestServices } from './test-remote.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

async function commandHarness(
  childMode?: 'continuable' | 'seeded-continuable' | 'seed-only' | 'one-shot' | 'unknown' | 'corrupt',
): Promise<{
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  inbox: Inbox
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  resolveAgent: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  installSessionReadTestServices(ctx)
  await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const sessionId = SessionId('commands-session')
  const ancestor = Session.create(SessionId('ancestor'))
  ancestor.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'continuable', provider: 'test', label: 'ancestor',
  }))
  // A seeded child inherits exactly the ancestor prefix; its own descriptor
  // is appended after creation, as the continuation manager does. `seed-only`
  // never appends one: the identity folds as continuable, but from the
  // inherited prefix rather than this Session's own suffix.
  const lineage = childMode === 'seeded-continuable' || childMode === 'seed-only'
    ? ancestor.snapshotEvents()
    : undefined
  const session = ctx.sessions.create(sessionId, {
    ...lineage === undefined ? {} : { seed: lineage, inheritedEventCount: SessionLogOffset(lineage.length) },
    meta: {
      cwd: '/workspace',
      ...(childMode === undefined ? {} : {
        origin: 'subagent' as const,
        parentSession: SessionId('offline-parent'),
      }),
      ...lineage === undefined ? {} : { isSeeded: true },
    },
  })
  if (childMode === 'continuable' || childMode === 'seeded-continuable') {
    session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'test', label: 'child',
    }))
  } else if (childMode === 'one-shot') {
    session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'test', label: 'child',
    })
  } else if (childMode === 'corrupt') {
    session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 1,
    } as never)
  }
  const inbox = createInboxStub()
  const steer = vi.fn((message: UserMessage) => { inbox.append('next-step', message) })
  const cancel = vi.fn()
  const agent = {
    id: session.id,
    options: { provider: 'fixture', model: 'fixture-model' },
    whenIdle: vi.fn(() => Promise.resolve()),
    runMaintenance: async () => { throw new Error('unexpected maintenance') },
    send: vi.fn(),
    inject: vi.fn(),
    session,
    model: unsupportedModel(),
    inbox,
    status: 'running',
    ctx,
    steer,
    followup: vi.fn(),
    cancel,
  } satisfies Agent
  await ctx.agents.register(agent)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const agents = new ApiSessionAgentController(ctx)
  const resolveAgent = vi.spyOn(agents, 'resolveAgent').mockImplementation(id => Promise.resolve(id === agent.id
    ? { agent }
    : { error: new RemoteError('session/not-found', 'missing', { sessionId: id }) }))
  vi.spyOn(agents, 'composeAgent').mockResolvedValue({ setup: () => {} })
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agent,
    inbox,
    steer,
    cancel,
    resolveAgent,
  }
}

async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

describe('Session queue commands', () => {
  it('edits a blockquote into ordinary text without changing prompt correlation', async () => {
    const { ctx, controller, agent, inbox } = await commandHarness()
    try {
      const message = createUserMessage({ content: [{ type: 'text', text: '> selected' }],
        source: { kind: 'user', rpcId: 'quote-edit' as import('../src/types.ts').SessionRequestId } })
      inbox.append('next-turn', message)
      await controller.updateQueue({ sessionId: agent.id, itemId: message.id,
        action: { kind: 'edit', content: [{ type: 'text', text: 'plain replacement' }] } })
      expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'plain replacement' }])
      expect(inbox.nextTurn[0]?.source).toEqual(message.source)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the cold Agent resolver rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const error = new RemoteError('session/agent-busy', 'owned by a child', { reason: 'subagent-owned' })
    const controller = new SessionCommandController(ctx, {
      resolveAgent: () => Promise.resolve({ error }),
    } as unknown as ApiSessionAgentController, '/workspace')
    try {
      await expect(controller.updateQueue({
        sessionId: SessionId('cold-child'), itemId: MessageId('pending'), action: { kind: 'remove' },
      })).rejects.toBe(error)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('edits, removes, steers, and rejects stale queue occurrences', async () => {
    const { ctx, controller, agent, inbox, steer, cancel } = await commandHarness()
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    const nextStep = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    inbox.append('next-turn', queued)
    inbox.append('next-step', nextStep)

    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id,
      itemId: queued.id,
      action: {
        kind: 'edit',
        content: [{
          // @ts-expect-error -- remote edit payloads can carry unsupported image blocks.
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('att-edit'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        }],
      },
    })), 'session/attachment-invalid')
    for (const content of [[], [{ type: 'text' as const, text: ' \t\n' }]]) {
      await expectFailure(Promise.resolve().then(() => controller.updateQueue({
        sessionId: agent.id,
        itemId: queued.id,
        action: { kind: 'edit', content },
      })), 'gateway/bad-request')
    }
    expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'queued' }])
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: SessionId('missing'), itemId: queued.id, action: { kind: 'remove' },
    })), 'session/queue-item-not-found')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: MessageId('missing'), action: { kind: 'remove' },
    })), 'session/queue-item-not-found')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: nextStep.id, action: { kind: 'steer' },
    })), 'session/steer-unavailable')

    Object.assign(agent, { status: 'idle' })
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: queued.id, action: { kind: 'steer' },
    })), 'session/steer-unavailable')
    expect(await controller.updateQueue({
      sessionId: agent.id,
      itemId: queued.id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] },
    })).toEqual({ accepted: true })
    expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'edited' }])
    // An edit rewrites content in place, so the occurrence a client addressed
    // by id stays addressable.
    expect(inbox.nextTurn[0]?.id).toBe(queued.id)
    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: nextStep.id, action: { kind: 'remove' },
    })).toEqual({ accepted: true })

    Object.assign(agent, { status: 'running' })
    const steered = inbox.nextTurn[0]
    if (steered === undefined) throw new Error('missing edited queue item')
    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: steered.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenCalledWith(steered)

    const queuedFile = createUserMessage({
      content: [{
        type: 'file',
        attachment: { attachmentId: AttachmentId('file-queued'), name: 'queued.txt', bytes: 6 },
      }],
      source: { kind: 'user', rpcId: 'file-rpc' as never },
    })
    inbox.append('next-turn', queuedFile)
    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: queuedFile.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenLastCalledWith(queuedFile)
    expect(queuedFile).toMatchObject({
      source: { kind: 'user', rpcId: 'file-rpc' },
      content: [{ type: 'file', attachment: { name: 'queued.txt', bytes: 6 } }],
    })

    await expectFailure(Promise.resolve().then(() => controller.cancel({
      sessionId: SessionId('missing'),
    })), 'session/not-found')
    expect(controller.cancel({ sessionId: agent.id })).toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await ctx.fiber.dispose()
  })

  it.each(['continuable', 'seeded-continuable'] as const)(
    'mutates both inbox destinations of a live %s child while its parent is offline',
    async (childMode) => {
      const { ctx, controller, agent, inbox, steer } = await commandHarness(childMode)
      const queued = createUserMessage({
        content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' },
      })
      const context = createUserMessage({
        content: [{ type: 'text', text: 'context' }], source: { kind: 'test' },
      })
      inbox.append('next-turn', queued)
      inbox.append('next-step', context)

      expect(await controller.updateQueue({
        sessionId: agent.id,
        itemId: context.id,
        action: { kind: 'edit', content: [{ type: 'text', text: 'edited context' }] },
      })).toEqual({ accepted: true })
      const editedContext = inbox.nextStep[0]
      expect(editedContext).toMatchObject({
        content: [{ type: 'text', text: 'edited context' }],
        source: context.source,
      })
      expect(editedContext?.id).toBe(context.id)
      if (editedContext === undefined) throw new Error('missing edited context')
      expect(await controller.updateQueue({
        sessionId: agent.id, itemId: editedContext.id, action: { kind: 'remove' },
      })).toEqual({ accepted: true })
      expect(await controller.updateQueue({
        sessionId: agent.id, itemId: queued.id, action: { kind: 'steer' },
      })).toEqual({ accepted: true })
      expect(steer).toHaveBeenCalledWith(queued)
      await ctx.fiber.dispose()
    },
  )

  it('removes the selected message before handing it to Agent steering', async () => {
    const { ctx, controller, agent, inbox, steer } = await commandHarness('continuable')
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second' }], source: { kind: 'user' },
    })
    inbox.append('next-turn', first)
    inbox.append('next-turn', second)
    // Stand in for the Agent's cancellation-convergence destination; the
    // command must accept whichever boundary `Agent.steer()` selects.
    steer.mockImplementation((message: UserMessage) => { inbox.append('next-turn', message) })

    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: first.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenCalledWith(first)
    // Ordering proves the removal happened before delivery rather than after.
    expect(inbox.nextTurn).toEqual([second, first])
    expect(inbox.nextStep).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps one-shot, seed-only, missing, and malformed child descriptors behind the ownership fence', async () => {
    for (const mode of ['one-shot', 'seed-only', 'unknown', 'corrupt'] as const) {
      const { ctx, controller, agent, inbox } = await commandHarness(mode)
      const queued = createUserMessage({
        content: [{ type: 'text', text: mode }], source: { kind: 'user' },
      })
      inbox.append('next-turn', queued)
      await expectFailure(Promise.resolve().then(() => controller.updateQueue({
        sessionId: agent.id, itemId: queued.id, action: { kind: 'remove' },
      })), 'session/agent-busy')
      for (const action of [
        { kind: 'recall' as const, requestId: brandString<SessionRequestId>('blocked-child'), expectedContent: queued.content },
        { kind: 'recover-recall' as const, requestId: brandString<SessionRequestId>('blocked-child') },
      ]) {
        await expectFailure(controller.updateQueue({ sessionId: agent.id, itemId: queued.id, action }), 'session/agent-busy')
      }
      expect(inbox.nextTurn).toEqual([queued])
      await ctx.fiber.dispose()
    }
  })
})

describe('Session attachment reads', () => {
  it.each(['commands-session', 'other-session', 'missing-session'])('reads a supplied reference without looking up history for %s', async (id) => {
    const { ctx, controller, agent, resolveAgent } = await commandHarness()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png', bytes: 2, width: 1, height: 1,
    }
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: ref }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))
    ctx.provide('attachments', { readImage } as never)
    const failHistory = (): never => { throw new Error('image reads must not access Session history') }
    const get = vi.spyOn(ctx.sessions, 'get').mockImplementation(failHistory)
    const snapshot = vi.spyOn(agent.session, 'snapshotEvents').mockImplementation(failHistory)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(failHistory)
    try {
      await expect(controller.attachment({ sessionId: SessionId(id), attachment: ref }))
        .resolves.toEqual({ attachment: ref, data: 'AQI=' })
      expect(readImage).toHaveBeenCalledExactlyOnceWith(ref)
      expect(get).not.toHaveBeenCalled()
      expect(snapshot).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
      expect(resolveAgent).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
      snapshot.mockRestore()
      observe.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    'INVALID_ATTACHMENT_REF', 'ATTACHMENT_NOT_FOUND', 'ATTACHMENT_CORRUPT', 'ATTACHMENT_READ_FAILED',
  ] as const)('returns %s as an explicit attachment failure', async (reason) => {
    const ctx = new Context()
    const readImage = vi.fn(() => Promise.reject(new AttachmentError('Stored image is unavailable.', reason)))
    ctx.provide('attachments', { readImage } as never)
    const controller = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/workspace')
    try {
      await expect(controller.attachment({
        sessionId: SessionId('unopened'),
        attachment: { attachmentId: AttachmentId('requested'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }))
        .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contains unexpected backend failures without exposing internal details', async () => {
    const ctx = new Context()
    ctx.provide('attachments', { readImage: () => Promise.reject(new Error('/private/storage failed')) } as never)
    const controller = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/workspace')
    try {
      await expect(controller.attachment({
        sessionId: SessionId('unopened'),
        attachment: { attachmentId: AttachmentId('requested'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }))
        .rejects.toMatchObject({ code: 'gateway/internal', message: 'Unable to read image attachment.', details: {} })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


describe('Session queue recall', () => {
  async function recallHarness() {
    const harness = await commandHarness()
    await harness.controller.initialize()
    const recall = harness.inbox.recall.bind(harness.inbox)
    harness.inbox.recall = (itemId, requestId) => {
      const message = harness.inbox.nextTurn.find(value => value.id === itemId)
      const removed = recall(itemId, requestId)
      if (removed && message !== undefined) harness.agent.session.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
        recall: { requestId, message },
      })
      return removed
    }
    const commit = vi.fn()
    const dispose = vi.fn()
    const stageRecalled = vi.fn((_: Agent, attachments: readonly StagedAttachment[]) => ({
      receiptIds: attachments.map((_, index) => brandString<FileUploadReceiptId>(`recalled-${index}`)),
      commit,
      [Symbol.dispose]: dispose,
    }))
    const retirePrompt = vi.fn()
    harness.ctx.provide('fileUploads', { stageRecalled, retirePrompt } as never)
    return { ...harness, commit, dispose, stageRecalled, retirePrompt }
  }

  const requestId = brandString<SessionRequestId>('recall-1')
  function queued(text = 'queued') {
    return createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })
  }

  it('recalls full ordered content with fresh receipts, preserving other queue items and retry identity', async () => {
    const { ctx, controller, agent, inbox, stageRecalled, commit, retirePrompt } = await recallHarness()
    try {
      const before = queued('before')
      const after = queued('after')
      const message = createUserMessage({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', attachment: { attachmentId: AttachmentId('image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
          { type: 'text', text: 'second' },
          { type: 'file', attachment: { attachmentId: AttachmentId('file'), name: 'notes.txt', bytes: 7 } },
        ],
        source: { kind: 'user', rpcId: brandString<SessionRequestId>('original') },
      })
      inbox.append('next-turn', before); inbox.append('next-turn', message); inbox.append('next-turn', after)
      const request = { sessionId: agent.id, itemId: message.id,
        action: { kind: 'recall' as const, requestId, expectedContent: message.content } }
      const result = await controller.updateQueue(request)
      expect(result.recalled?.content).toEqual(message.content)
      expect(result.recalled?.attachments).toEqual([
        { type: 'image', receiptId: 'recalled-0', image: { attachmentId: 'image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
        { type: 'file', receiptId: 'recalled-1', file: { attachmentId: 'file', name: 'notes.txt', bytes: 7 } },
      ])
      expect(inbox.nextTurn).toEqual([before, after])
      expect(stageRecalled).toHaveBeenCalledTimes(1)
      expect(commit).toHaveBeenCalledTimes(1)
      expect(retirePrompt).toHaveBeenCalledWith(agent, 'original')
      expect(await controller.updateQueue(request)).toEqual(result)
      expect(stageRecalled).toHaveBeenCalledTimes(1)
      await expect(controller.updateQueue({ ...request, itemId: after.id })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      expect(inbox.nextTurn).toEqual([before, after])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects stale content, running/next-step occurrences, foreign sessions and non-user sources without staging', async () => {
    const { ctx, controller, agent, inbox, stageRecalled } = await recallHarness()
    try {
      const message = queued()
      const step = queued('step')
      const plugin = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'test' } })
      inbox.append('next-turn', message); inbox.append('next-step', step); inbox.append('next-turn', plugin)
      for (const [sessionId, itemId, content] of [
        [agent.id, message.id, queued('stale').content], [agent.id, step.id, step.content],
        [agent.id, plugin.id, plugin.content], [SessionId('foreign'), message.id, message.content],
        [agent.id, MessageId('already-claimed'), message.content],
      ] as const) {
        await expect(controller.updateQueue({ sessionId, itemId,
          action: { kind: 'recall', requestId, expectedContent: content } })).rejects.toBeDefined()
      }
      expect(stageRecalled).not.toHaveBeenCalled()
      expect(inbox.nextTurn).toEqual([message, plugin])
      expect(inbox.nextStep).toEqual([step])
    } finally { await ctx.fiber.dispose() }
  })

  it('rolls back staged receipts on precommit failure and succeeds on a same-ID retry', async () => {
    const { ctx, controller, agent, inbox, commit, dispose } = await recallHarness()
    try {
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file',
        attachment: { attachmentId: AttachmentId('rollback-file'), name: 'note.txt', bytes: 3 } }] })
      inbox.append('next-turn', message)
      const remove = vi.spyOn(inbox, 'recall').mockImplementationOnce(() => { throw new Error('storage failed') })
      const request = { sessionId: agent.id, itemId: message.id,
        action: { kind: 'recall' as const, requestId, expectedContent: message.content } }
      await expect(controller.updateQueue(request)).rejects.toThrow('storage failed')
      expect(commit).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1)
      expect(inbox.nextTurn).toEqual([message])
      remove.mockRestore()
      expect((await controller.updateQueue(request)).recalled?.content).toEqual(message.content)
    } finally { await ctx.fiber.dispose() }
  })

  it('retains committed recall when a synchronous discard observer throws', async () => {
    const { ctx, controller, agent, inbox, commit } = await recallHarness()
    try {
      const message = queued(); inbox.append('next-turn', message)
      const original = inbox.recall.bind(inbox)
      const remove = vi.spyOn(inbox, 'recall').mockImplementation((id, recallId) => {
        original(id, recallId)
        throw new Error('observer failed')
      })
      const request = { sessionId: agent.id, itemId: message.id,
        action: { kind: 'recall' as const, requestId, expectedContent: message.content } }
      const result = await controller.updateQueue(request)
      expect(result.recalled?.content).toEqual(message.content)
      expect(commit).not.toHaveBeenCalled()
      expect(await controller.updateQueue(request)).toEqual(result)
      expect(remove).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })
})
