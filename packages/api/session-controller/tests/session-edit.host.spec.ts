import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionEditRequest, SessionRequestId } from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

function appendTurn(session: Session, turn: number, prompt: string, answer: string): SessionEvent<'user/message'> {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: answer }], source: { provider: 'fixture', model: 'fixture-model' } }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return user
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture' }],
    resolveModelInfo: () => Promise.resolve({ inputModalities: ['text', 'image'] }),
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const session = ctx.sessions.create(SessionId('edit-session'), { meta: { cwd: '/workspace' } })
  const sent: Parameters<Agent['send']>[3][] = []
  const agent = {
    id: session.id,
    options: { provider: 'fixture', model: 'fixture-model' },
    session,
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle' as const,
    ctx,
    send(message, _target, _wakeup, options) {
      sent.push(options)
      const turn = 10
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('user/message', message, options?.surfaceIntent ?? { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    },
    followup: vi.fn(), steer: vi.fn(), inject: vi.fn(), cancel: vi.fn(),
    runMaintenance: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    model: {
      current: () => ({ provider: 'fixture', model: 'fixture-model' }),
      select: vi.fn(),
    },
  } satisfies Agent
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    serializeImageAdmission: (_agent: Agent, operation: () => Promise<unknown>) => operation(),
  } as never as ApiSessionAgentController
  ctx.agents.register(agent)
  return { ctx, session, controller: new SessionCommandController(ctx, agents, '/workspace'), sent }
}

function request(messageSeq: number): SessionEditRequest {
  return { requestId: 'edit-request' as SessionRequestId, sessionId: SessionId('edit-session'), messageSeq, expectedLastUserSeq: messageSeq, text: 'edited' }
}

describe('session.edit', () => {
  it('keeps the Session identity and replaces the current model surface', async () => {
    const fixture = await harness()
    appendTurn(fixture.session, 1, 'first', 'first answer')
    const target = appendTurn(fixture.session, 2, 'second', 'second answer')
    await expect(fixture.controller.edit(request(target.seq), new AbortController().signal)).resolves.toMatchObject({ accepted: true })
    expect(fixture.sent[0]).toMatchObject({
      position: 'front',
      surfaceIntent: { surfaceOp: { op: 'replace' }, conversationOp: { op: 'replace' } },
    })
    expect(fixture.session.id).toBe(SessionId('edit-session'))
    expect(fixture.session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'first answer' }],
      [{ type: 'text', text: 'edited' }],
    ])
    await fixture.ctx.fiber.dispose()
  })

  it('rejects an edit when a newer human message entered after editor activation', async () => {
    const fixture = await harness()
    const target = appendTurn(fixture.session, 1, 'first', 'answer')
    appendTurn(fixture.session, 2, 'newer', 'newer answer')
    await expect(fixture.controller.edit(request(target.seq), new AbortController().signal)).rejects.toMatchObject({ code: 'session/edit-stale' })
    expect(fixture.sent).toHaveLength(0)
    await fixture.ctx.fiber.dispose()
  })

  it.each(['', 'add text'])('retains attachment-only content when replacement text is %j', async (text) => {
    const fixture = await harness()
    const image: ImageAttachmentRef = {
      attachmentId: 'edit-image' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    }
    fixture.session.append('turn/start', { turn: 1 })
    fixture.session.append('step/start', { turn: 1, step: 1 })
    const target = fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: image }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    fixture.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'fixture', model: 'fixture-model' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    fixture.session.append('step/end', { turn: 1, step: 1 })
    fixture.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expect(fixture.controller.edit({ ...request(target.seq), text }, new AbortController().signal))
      .resolves.toMatchObject({ accepted: true })
    const replacement = fixture.session.snapshotEvents().findLast(event => event.type === 'user/message')
    expect(replacement?.type === 'user/message' ? replacement.data.content : undefined).toEqual(
      text === '' ? [{ type: 'image', attachment: image }] : [{ type: 'text', text }, { type: 'image', attachment: image }],
    )
    await fixture.ctx.fiber.dispose()
  })

  it('rejects a latest human message that is steering after the opening step', async () => {
    const fixture = await harness()
    fixture.session.append('turn/start', { turn: 1 })
    fixture.session.append('step/start', { turn: 1, step: 1 })
    fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'opening' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    fixture.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'fixture', model: 'fixture-model' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    fixture.session.append('step/end', { turn: 1, step: 1 })
    const steering = fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    fixture.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expect(fixture.controller.edit(request(steering.seq), new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/edit-unavailable' })
    expect(fixture.sent).toHaveLength(0)
    await fixture.ctx.fiber.dispose()
  })
})
