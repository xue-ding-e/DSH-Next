/** Real JSONL cold continuation; only unavailable native OS locking is replaced. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import SubagentRuntime, { NO_START_CAPABILITIES } from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from './local-activation.ts'
import { TestSessionQuery } from './test-session-query.ts'

// Existing fixture seam, not a production lock bypass or native cross-process validation.
vi.mock('@deepseek-ai/node-addon-system/flock', () => ({
  tryLockExclusive: vi.fn<(_fd: number) => Promise<void>>().mockResolvedValue(undefined),
}))

it('covers real cold observation through restored publication and final JSONL handle cleanup', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('initial'), textResponse('restored')]))
  ctx.subagents.registerProvider({ name: 'local', capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false, prepareContinuable: () => Promise.resolve({}),
  })
  const { agent: parent } = await ctx.agents.create({ sessionId: SessionId('cold-admission-parent'),
    agentOptions: { provider: 'mock', model: 'mock' } })
  const activation = await ctx.subagents.startActivation({ provider: 'local', label: 'child', delivery: 'caller',
    signal: new AbortController().signal, request: { parent, prompt: [{ type: 'text', text: 'initial task' }] } })
  await activation.result
  expect(ctx.agents.get(activation.childId)).toBeUndefined()
  expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)

  const observed = Promise.withResolvers<undefined>()
  const releaseRead = Promise.withResolvers<undefined>()
  const closing = Promise.withResolvers<undefined>()
  const releaseClose = Promise.withResolvers<undefined>()
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
    observed.resolve(undefined)
    await releaseRead.promise
    return observe(...args)
  })
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === activation.childId && args[1] === 'write') {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closing.resolve(undefined)
        await releaseClose.promise
        await close()
      })
    }
    return handle
  })
  const publication: boolean[] = []
  ctx.on('subagent/start', () => { publication.push(ctx.subagents.hasOwnerActivity(parent)) })
  try {
    const sending = ctx.subagents.sendMessage(parent, activation.childId,
      [{ type: 'text', text: 'resume task' }], { signal: new AbortController().signal })
    expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
    await observed.promise
    expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
    releaseRead.resolve(undefined)
    await sending
    await closing.promise
    expect(publication).toEqual([true])
    expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
    releaseClose.resolve(undefined)
    await ctx.subagents.waitForChildren(parent)
    expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    const log = await ctx.sessionPersistence.open(activation.childId, 'read')
    const history = await log.read()
    await log.close()
    expect(JSON.stringify(history.events)).toContain('restored')
  } finally {
    releaseRead.resolve(undefined)
    releaseClose.resolve(undefined)
  }
})
