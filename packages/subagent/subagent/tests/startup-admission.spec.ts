/** Pending subagent work is visible before directory resolution and cold reads. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import SubagentRuntime from '../src/index.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { managerState } from './manager-internals.ts'

async function fixture() {
  const ctx = new Context()
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const agents = await ctx.plugin(AgentRegistry)
  const parent = await externalTestParent(ctx)
  await ctx.plugin(SubagentRuntime)
  return { ctx, parent, agents }
}

const prompt = [{ type: 'text' as const, text: 'work' }]

describe('subagent admission activity', () => {
  it.each(['local', 'external'] as const)('tracks %s startup before the directory await and releases rejection', async (kind) => {
    const { ctx, parent } = await fixture()
    const blocked = Promise.withResolvers<string>()
    vi.spyOn(ctx.workingDirectory, 'ensure').mockImplementation(() => blocked.promise)
    const capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
    const reject = () => Promise.reject(new Error('provider rejected'))
    ctx.subagents.registerProvider({ name: kind, capabilities, inheritsParentContext: false,
      ...(kind === 'local' ? { prepareContinuable: reject } : { start: reject }),
    })
    const starting = ctx.subagents.startActivation({ provider: kind, label: kind, delivery: 'caller',
      signal: new AbortController().signal, request: { parent, prompt } })
    const rejected = expect(starting).rejects.toThrow('provider rejected')
    try {
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      expect(ctx.subagents.hasOwnerActivity({ ...parent })).toBe(false)
      blocked.resolve('/workspace')
      await rejected
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    } finally {
      blocked.resolve('/workspace')
      await Promise.allSettled([starting, rejected])
    }
  })

  it('tracks cold delivery before its first query and drains the combined signal', async () => {
    const { ctx, parent } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<never>()
    let observedSignal: AbortSignal | undefined
    ctx.provide('sessionQuery', {
      observeSession: (_id: unknown, options: { signal: AbortSignal }) => {
        observedSignal = options.signal
        entered.resolve(undefined)
        return release.promise
      },
    } as never)
    const sending = ctx.subagents.sendMessage(parent, SessionId('cold-child'), prompt,
      { signal: new AbortController().signal })
    const rejected = expect(sending).rejects.toThrow()
    try {
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      await entered.promise
      const draining = ctx.subagents.drainDescendants([parent])
      expect(observedSignal?.aborted).toBe(true)
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      release.reject(new Error('query stopped'))
      await rejected
      await draining
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    } finally {
      release.reject(new Error('query cleanup'))
      await Promise.allSettled([sending, rejected])
    }
  })

  it('keeps local preparation admitted until cancellation cleanup settles', async () => {
    const { ctx, parent } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<never>()
    let prepareSignal: AbortSignal | undefined
    ctx.subagents.registerProvider({ name: 'prepared', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      prepareContinuable: ({ signal }) => {
        prepareSignal = signal
        entered.resolve(undefined)
        return release.promise
      },
    })
    const starting = ctx.subagents.startActivation({ provider: 'prepared', label: 'prepared', delivery: 'caller',
      signal: new AbortController().signal, request: { parent, prompt } })
    const rejected = expect(starting).rejects.toThrow()
    try {
      await entered.promise
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      let drained = false
      const draining = ctx.subagents.drainDescendants([parent]).then(() => { drained = true })
      expect(prepareSignal?.aborted).toBe(true)
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      release.reject(new Error('preparation released'))
      await rejected
      await draining
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    } finally {
      release.reject(new Error('preparation cleanup'))
      await Promise.allSettled([starting, rejected])
    }
  })

  it('tracks cold deliveries queued behind a child lock and rejects cancellation before observing', async () => {
    const { ctx, parent } = await fixture()
    const childId = SessionId('locked-child')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const locking = managerState(ctx).locks.run(childId, () => { entered.resolve(undefined); return release.promise })
    await entered.promise
    const observe = vi.fn().mockRejectedValue(new Error('must not observe'))
    ctx.provide('sessionQuery', { observeSession: observe } as never)
    const caller = new AbortController()
    const sending = ctx.subagents.sendMessage(parent, childId, prompt, { signal: caller.signal })
    const rejected = expect(sending).rejects.toThrow()
    try {
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      caller.abort()
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      release.resolve(undefined)
      await locking
      await rejected
      expect(observe).not.toHaveBeenCalled()
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    } finally {
      caller.abort()
      release.resolve(undefined)
      await Promise.allSettled([locking, sending, rejected])
    }
  })

  it('covers external publication, idle lifetime, and closing resource cleanup without a gap', async () => {
    const { ctx, parent } = await fixture()
    const sibling = await externalTestParent(ctx)
    const result = Promise.withResolvers<{ output: []; stopReason: 'completed' }>()
    const cleaning = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const visibility: boolean[] = []
    ctx.on('subagent/start', () => { visibility.push(ctx.subagents.hasOwnerActivity(parent)) })
    ctx.subagents.registerProvider({ name: 'external', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: () => Promise.resolve({ id: SessionId('external-resident'), result: result.promise,
        dispose: () => { cleaning.resolve(undefined); return release.promise },
      }),
    })
    try {
      const activation = await ctx.subagents.startActivation({ provider: 'external', label: 'external', delivery: 'caller',
        signal: new AbortController().signal, request: { parent, prompt } })
      expect(visibility).toEqual([true])
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      expect(ctx.subagents.hasOwnerActivity(sibling)).toBe(false)
      const closing = activation.dispose()
      await cleaning.promise
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      result.resolve({ output: [], stopReason: 'completed' })
      release.resolve(undefined)
      await closing
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    } finally {
      result.resolve({ output: [], stopReason: 'completed' })
      release.resolve(undefined)
    }
  })


  it('retains rejected external publication until rollback cleanup completes', async () => {
    const { ctx, parent } = await fixture()
    const cleaning = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({ name: 'rejected-publication', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: () => Promise.resolve({ id: SessionId('rolled-back'),
        result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
        dispose: () => { cleaning.resolve(undefined); return release.promise },
      }),
    })
    const caller = new AbortController()
    ctx.on('subagent/start', () => { caller.abort(new Error('publication refused')) })
    const starting = ctx.subagents.startActivation({ provider: 'rejected-publication', label: 'rejected', delivery: 'caller',
      signal: caller.signal, request: { parent, prompt } })
    const rejected = expect(starting).rejects.toThrow('publication refused')
    try {
      await cleaning.promise
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(true)
      release.resolve(undefined)
      await rejected
      expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([starting, rejected])
    }
  })

  it('does not retain an admission when the caller was already cancelled', async () => {
    const { ctx, parent } = await fixture()
    const caller = new AbortController()
    caller.abort()
    await expect(ctx.subagents.sendMessage(parent, SessionId('never-admitted'), prompt,
      { signal: caller.signal })).rejects.toThrow()
    expect(ctx.subagents.hasOwnerActivity(parent)).toBe(false)
  })

  it('fails closed while the Agent injection is unloading and preparation cleanup is pending', async () => {
    const { ctx, parent, agents } = await fixture()
    const runtime = ctx.subagents
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<never>()
    runtime.registerProvider({ name: 'unloading', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      prepareContinuable: ({ signal }) => {
        signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
        entered.resolve(undefined)
        return release.promise
      },
    })
    const starting = runtime.startActivation({ provider: 'unloading', label: 'unloading', delivery: 'caller',
      signal: new AbortController().signal, request: { parent, prompt } })
    const rejected = expect(starting).rejects.toThrow()
    let disposing: Promise<void> | undefined
    try {
      await entered.promise
      expect(runtime.hasOwnerActivity(parent)).toBe(true)
      let disposed = false
      disposing = agents.dispose().then(() => { disposed = true })
      await aborted.promise
      await setImmediate()
      expect(disposed).toBe(false)
      expect(() => runtime.hasOwnerActivity(parent)).toThrow(/require the agents service/)
      release.reject(new Error('unload preparation released'))
      await rejected
      await disposing
      expect(disposed).toBe(true)
    } finally {
      release.reject(new Error('unload cleanup'))
      await Promise.allSettled([starting, rejected, disposing])
    }
  })

})
