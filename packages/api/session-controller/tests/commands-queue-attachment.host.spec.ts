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
import { createAssistantMessage, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { unsupportedModel, createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

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

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  }
}

function event(type: string, seq: SessionSeq, data: unknown): SessionEvent {
  const surface = ['user/message', 'system/message', 'developer/message', 'tool/result'].includes(type)
  return { type, seq, time: seq + 1, data, ...surface ? { surfaceOp: 'append' } : {} } as SessionEvent
}

async function persistedController(
  events: SessionEvent[],
  readImage: (ref: ImageAttachmentRef) => Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>,
  workspace: Pick<SessionHeader, 'cwd'> = { cwd: '/workspace' },
): Promise<{ ctx: Context; controller: SessionCommandController; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const sessionId = SessionId('cold-attachment')
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    ...workspace,
    isSeeded: false,
  }
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({
      meta,
      inheritedEventCount: SessionLogOffset(0),
      events,
    }),
  }) as never)
  installSessionReadTestServices(ctx)
  ctx.provide('attachments', { readImage } as never)
  const agents = { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController
  return { ctx, controller: new SessionCommandController(ctx, agents, '/workspace'), sessionId }
}

describe('Session attachment authorization', () => {
  it.each([
    ['system/message', 'message'], ['developer/message', 'message'], ['tool/result', 'message'],
    ['team/message/queued', 'message'], ['tool/ptc-dispatch', 'content'],
    ['compaction/summary', 'summary'], ['compaction/summary', 'rawOutput'],
  ] as const)('reads the declared %s %s content without rewriting it', async (type, field) => {
    const ref = imageRef(`${type}-${field}`)
    const content = [{ type: 'image', attachment: ref }]
    const message = type === 'team/message/queued' ? { content }
      : type === 'tool/result' ? {
        id: 'declared-message', role: 'tool', source: { kind: 'tool', callId: 'declared-call' },
        toolCallId: 'declared-call', isError: false, content,
      } : {
        id: 'declared-message', role: type === 'developer/message' ? 'developer' : 'system',
        source: { kind: 'system-prompt' }, content,
      }
    const data = field === 'message' ? { message } : { [field]: content }
    const events = [event(type, SessionSeq(0), data)]
    const saved = JSON.stringify(events)
    const readImage = vi.fn((image: ImageAttachmentRef) => Promise.resolve({ ref: image, data: Uint8Array.of(1) }))
    const fixture = await persistedController(events, readImage)
    try {
      await expect(fixture.controller.attachment({ sessionId: fixture.sessionId, attachmentId: ref.attachmentId }))
        .resolves.toEqual({ attachment: ref, data: 'AQ==' })
      expect(readImage).toHaveBeenCalledExactlyOnceWith(ref)
      expect(JSON.stringify(events)).toBe(saved)
    } finally {
      await fixture.ctx.fiber.dispose()
    }
  })

  it('does not authorize an attachment through malformed inbox entries', async () => {
    const ref = imageRef('not-referenced')
    for (const value of [undefined, null, {}, [null, 1, []]]) {
      const readImage = vi.fn((image: ImageAttachmentRef) => Promise.resolve({ ref: image, data: Uint8Array.of(1) }))
      const fixture = await persistedController([event('agent/inbox/spliced', SessionSeq(0), { inserted: value })], readImage)
      try {
        await expect(fixture.controller.attachment({ sessionId: fixture.sessionId, attachmentId: ref.attachmentId }))
          .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } })
        expect(readImage).not.toHaveBeenCalled()
      } finally {
        await fixture.ctx.fiber.dispose()
      }
    }
  })

  it('ignores unrelated fields of a known message event and its content blocks', async () => {
    const ref = imageRef('not-a-content-occurrence')
    const content = [{ type: 'image', attachment: ref }]
    const stored = event('user/message', SessionSeq(0), {
      id: 'metadata', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'no image', content }, { type: 'plugin:vendor', data: { content }, content }],
      message: { content }, inserted: [{ content }],
    })
    const readImage = vi.fn((image: ImageAttachmentRef) => Promise.resolve({ ref: image, data: Uint8Array.of(1) }))
    const fixture = await persistedController([stored], readImage)
    try {
      await expect(fixture.controller.attachment({ sessionId: fixture.sessionId, attachmentId: ref.attachmentId }))
        .rejects.toMatchObject({ code: 'session/attachment-invalid' })
      expect(readImage).not.toHaveBeenCalled()
    } finally {
      await fixture.ctx.fiber.dispose()
    }
  })

  it.each(['external/image-record', 'session/title-llm-request'])('denies attachment access from %s without an attachment carrier', async (type) => {
    const ref = imageRef('opaque-event-image')
    const content = [{ type: 'image', attachment: ref }]
    const opaque = { ...event(type, SessionSeq(0), {
      content, message: { content }, inserted: [{ content }], messages: [{ content }],
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: content[0] } }],
    }), ignorable: true as const }
    const readImage = vi.fn((image: ImageAttachmentRef) => Promise.resolve({ ref: image, data: Uint8Array.of(1) }))
    const fixture = await persistedController([opaque], readImage)
    try {
      await expect(fixture.controller.attachment({ sessionId: fixture.sessionId, attachmentId: ref.attachmentId }))
        .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } })
      expect(readImage).not.toHaveBeenCalled()
    } finally {
      await fixture.ctx.fiber.dispose()
    }
  })

  it('finds references in direct, message, inserted, and streamed content', async () => {
    const direct = imageRef('direct')
    const message = imageRef('message')
    const inserted = imageRef('inserted')
    const streamed = imageRef('streamed')
    const events: SessionEvent[] = [
      { ...event('user/message', SessionSeq(0), {
        id: 'direct', role: 'user', source: { kind: 'user' },
        content: [null, [], { type: 'text', text: 'none' }, { type: 'image', attachment: direct }],
      }), ignorable: true as const },
      {
        type: 'assistant/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            content: [{ type: 'image', attachment: message }],
            source: { provider: 'fixture', model: 'fixture' },
          }),
        },
      },
      event('agent/inbox/spliced', SessionSeq(2), {
        target: 'next-turn',
        start: 0,
        inserted: [null, 1, [], { content: [] }, createUserMessage({
          content: [{ type: 'image', attachment: inserted }],
          source: { kind: 'user' },
        })],
      }),
      event('assistant/attempt', SessionSeq(3), {
        turn: 1,
        step: 1,
        stream: [
          {
            type: 'chunk',
            time: 3,
            chunk: { type: 'block-start', index: 0, blockType: 'text' },
          },
          {
            type: 'chunk',
            time: 3,
            chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
          },
        ],
      }),
      event('assistant/attempt', SessionSeq(4), {
        turn: 1,
        step: 1,
        stream: [{
          type: 'chunk',
          time: 4,
          chunk: { type: 'block-end', index: 0, block: { type: 'image', attachment: streamed } },
        }],
      }),
    ]
    const readImage = vi.fn((ref: ImageAttachmentRef) => Promise.resolve({ ref, data: Uint8Array.of(1) }))
    const { ctx, controller, sessionId } = await persistedController(events, readImage)

    for (const ref of [direct, message, inserted, streamed]) {
      await expect(controller.attachment({ sessionId, attachmentId: ref.attachmentId }))
        .resolves.toEqual({ attachment: ref, data: 'AQ==' })
    }
    expect(readImage).toHaveBeenCalledTimes(4)
    await ctx.fiber.dispose()
  })

  it('maps missing persistence identities and attachment backend failures', async () => {
    const noPersistence = new Context()
    await noPersistence.plugin(SessionStore)
    installSessionReadTestServices(noPersistence)
    const noPersistenceController = new SessionCommandController(
      noPersistence,
      { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController,
      '/workspace',
    )
    await expectFailure(noPersistenceController.attachment({
      sessionId: SessionId('missing'), attachmentId: AttachmentId('att'),
    }), 'session/not-found')

    const missing = new Context()
    await missing.plugin(SessionStore)
    missing.provide('sessionPersistence', testSessionPersistence(missing, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    }) as never)
    installSessionReadTestServices(missing)
    const missingController = new SessionCommandController(
      missing,
      { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController,
      '/workspace',
    )
    await expectFailure(missingController.attachment({
      sessionId: SessionId('missing'), attachmentId: 'att' as never,
    }), 'session/not-found')

    for (const thrown of [
      new AttachmentError('stored image is unavailable', 'ATTACHMENT_NOT_FOUND'),
      new Error('backend offline'),
    ]) {
      const ref = imageRef(`failure-${thrown.name}`)
      const fixture = await persistedController(
        [event('user/message', SessionSeq(0), { id: 'failure', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] })],
        () => Promise.reject(thrown),
      )
      await expectFailure(fixture.controller.attachment({
        sessionId: fixture.sessionId,
        attachmentId: ref.attachmentId,
      }), thrown instanceof AttachmentError ? 'session/attachment-invalid' : 'gateway/internal')
      await fixture.ctx.fiber.dispose()
    }
  })

  it('rejects a cold Session without cwd before reading its referenced image', async () => {
    const ref = imageRef('missing-cwd')
    const readImage = vi.fn(async () => ({ ref, data: new Uint8Array([1]) }))
    const fixture = await persistedController(
      [event('user/message', SessionSeq(0), { id: 'image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] })],
      readImage,
      {},
    )
    try {
      await expect(fixture.controller.attachment({ sessionId: fixture.sessionId, attachmentId: ref.attachmentId }))
        .rejects.toMatchObject({ code: 'session/not-found', details: { sessionId: fixture.sessionId } })
      expect(readImage).not.toHaveBeenCalled()
    } finally {
      await fixture.ctx.fiber.dispose()
    }
  })

  it('maps a cold observation failure to an internal authorization error', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage offline'))
    const controller = new SessionCommandController(
      ctx,
      { resolveAgent: vi.fn() } as unknown as ApiSessionAgentController,
      '/workspace',
    )

    await expectFailure(controller.attachment({
      sessionId: SessionId('unreadable'), attachmentId: AttachmentId('att'),
    }), 'gateway/internal')
    await ctx.fiber.dispose()
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
