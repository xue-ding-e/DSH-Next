/** Directory confirmation through the real Gateway, Peer, Agent and file sandbox. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { RootApprovalPreview } from '@deepseek-ai/dsh-sandbox-policy/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import Subagents from '@deepseek-ai/dsh-subagent'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Terminals from '@deepseek-ai/dsh-terminal'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'
import { createSessionTestController } from './test-remote.ts'
import { TYPERT } from '../lib/typert.host.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'root-test-guest': { readonly kind: 'root-test-guest' }
  }
}

class SupportedSandbox extends SandboxProvider {
  override supportsAdditionalWritableRoots(mode: import('@deepseek-ai/dsh-sandbox/types').SandboxMode): boolean { return mode === 'workspace-write' }
  override confine(): Promise<never> { throw new Error('No process execution in this fixture') }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
async function fixture(scopedPolicy = false) {
  const base = await realpath(await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-root-approval-')))
  assertWorkspaceOutsideTemp(base)
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const primary = join(base, 'primary'), source = join(base, 'source'), reference = join(base, 'reference')
  await Promise.all([primary, source, reference].map(path => mkdir(path)))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  ctx.typert.register(TYPERT)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: primary })
  const fsFiber = ctx.plugin(SandboxedFileSystem, { cwd: primary })
  await fsFiber
  const sandboxFiber = ctx.plugin(SupportedSandbox)
  await sandboxFiber
  await ctx.plugin(Jobs)
  await ctx.plugin(Terminals)
  await ctx.plugin(WorkingDirectory)
  const subagentFiber = ctx.plugin(Subagents)
  await subagentFiber
  const ownerCtx = scopedPolicy ? ctx.isolate('sandboxPolicy') : ctx
  const policyFiber = scopedPolicy ? ownerCtx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: primary }) : undefined
  await policyFiber
  await ownerCtx.plugin(AgentLoop, { agents: [] })
  const handle = await ownerCtx.agents.create({ sessionId: SessionId('approved-session'), meta: { cwd: primary } })
  const { agent } = handle
  ctx.sandboxPolicy.initializeRequestedRoots(agent.session, [
    { path: source, access: 'write' }, { path: reference, access: 'reference' },
  ])
  const controller = await createSessionTestController(ctx, {
    cwd: primary, defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
  })
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const call = (method: string, args: Record<string, unknown>, caller: PeerScope = peer, signal?: AbortSignal) =>
    ctx.typertGateway.invoke({ peer: caller, namespace: 'session', method, args, ...signal === undefined ? {} : { signal } })
  return { ctx, agent, controller, peer, call, source, reference,
    subagentFiber, policyFiber, handle, fsFiber, sandboxFiber, primary, ownerCtx }
}

describe('explicit root permission Remote calls', () => {
  it('does not authorize a direct in-process call with no Peer', async () => {
    const { controller, agent } = await fixture()
    await expect(controller.prepareRoots({ sessionId: agent.id })).rejects.toMatchObject({ code: 'session/roots-owner-required' })
  })

  it('confirms once and bridges only write selections into the real filesystem policy', async () => {
    const { ctx, agent, call, source, reference } = await fixture()
    const target = await ctx.fs.resolve(join(source, 'allowed.txt'))
    const policy = () => ctx.sandboxPolicy.resolve({ session: agent.session })
    await expect(ctx.fs.writeText(target, 'before', undefined, undefined, policy())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    expect(preview.roots).toEqual([{ path: source, access: 'write' }, { path: reference, access: 'reference' }])
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })
    expect(policy().additionalWritableRoots).toEqual([source])
    await ctx.fs.writeText(target, 'after', undefined, undefined, policy())
    const ref = await ctx.fs.resolve(join(reference, 'denied.txt'))
    await expect(ctx.fs.writeText(ref, 'no', undefined, undefined, policy())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow()
    setSandboxMode(agent.session, 'read-only')
    setSandboxMode(agent.session, 'workspace-write')
    expect(policy().additionalWritableRoots).toBeUndefined()
    await expect(ctx.fs.writeText(target, 'revoked', undefined, undefined, policy())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('rejects non-owner peers even with broad action roles and a forged wire principal', async () => {
    const { ctx, agent, call } = await fixture()
    ctx.remoteAccess.registerPolicy('root-test-guest', { bindings: () => [{
      role: { name: 'root-test-all', resource: 'session', actions: ['session/prepareRoots', 'session/confirmRoots'] },
      resource: { kind: 'session', id: agent.id },
    }] })
    const guest = new Peer(ctx, { principal: { kind: 'root-test-guest' } })
    await expect(call('prepareRoots', { request: { sessionId: agent.id, principal: { kind: 'owner' } } }, guest))
      .rejects.toMatchObject({ code: 'session/roots-owner-required' })
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it('admits only one concurrent confirmation of the same nonce', async () => {
    const { agent, call } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    const results = await Promise.allSettled([1, 2].map(() =>
      call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  it('rejects malformed wire requests through generated parameter codecs', async () => {
    const { agent, call } = await fixture()
    await expect(call('prepareRoots', { request: { sessionId: 42 } })).rejects.toThrow()
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: 42 } })).rejects.toThrow()
  })

  it('binds a nonce to the exact Peer and supports explicit cancellation', async () => {
    const { ctx, agent, call } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    const stranger = new Peer(ctx, { principal: { kind: 'owner' } })
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } }, stranger)).rejects.toThrow()
    await call('cancelRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it.each(['mode', 'same-mode', 'same-roots'] as const)('invalidates a preview after %s events', async (change) => {
    const { ctx, agent, call } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    if (change === 'same-roots') {
      agent.session.append('sandbox/roots-requested', { roots: preview.roots })
    } else {
      if (change === 'mode') setSandboxMode(agent.session, 'read-only')
      setSandboxMode(agent.session, 'workspace-write')
    }
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it('expires a preview and consumes its nonce before trying a busy maintenance phase', async () => {
    const { agent, call } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    const clock = vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt)
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow(/expired/)
    clock.mockRestore()
    const fresh = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    const release = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(async () => { await release.promise })
    try {
      expect(agent.status).toBe('idle')
      await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: fresh.nonce } })).rejects.toThrow()
    } finally {
      release.resolve(undefined)
      await maintenance
    }
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: fresh.nonce } })).rejects.toThrow(/stale/)
  })

  it.each(['terminal', 'job', 'subagent'] as const)('refuses active %s work without granting paths', async (family) => {
    const { ctx, agent, call } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    if (family === 'terminal') vi.spyOn(ctx.terminals, 'hasOwnerActivity').mockReturnValue(true)
    if (family === 'subagent') vi.spyOn(ctx.subagents, 'hasOwnerActivity').mockReturnValue(true)
    if (family === 'job') vi.spyOn(ctx.jobs, 'list').mockReturnValue([{ owner: agent.id, status: 'stopping' }] as never)
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow(/Close terminals/)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it.each(['peer', 'invocation', 'maintenance', 'expiry', 'resource', 'capability', 'selection', 'fs-provider', 'sandbox-provider'] as const)(
    'rechecks %s after filesystem validation has awaited', async (change) => {
      const { ctx, agent, peer, call, fsFiber, sandboxFiber, primary } = await fixture()
      const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const carrier = new AbortController()
      const resolve = ctx.fs.resolve.bind(ctx.fs)
      vi.spyOn(ctx.fs, 'resolve').mockImplementation(async (...args) => {
        entered.resolve(undefined)
        await release.promise
        return resolve(...args)
      })
      const confirming = call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } }, peer, carrier.signal)
      const rejected = expect(confirming).rejects.toThrow()
      try {
        await entered.promise
        if (change === 'peer') await peer.dispose()
        if (change === 'invocation') carrier.abort()
        if (change === 'maintenance') agent.cancel({ kind: 'user' })
        if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt)
        if (change === 'resource') vi.spyOn(ctx.terminals, 'hasOwnerActivity').mockReturnValue(true)
        if (change === 'capability') vi.spyOn(ctx.sandbox, 'supportsAdditionalWritableRoots').mockReturnValue(false)
        if (change === 'selection') agent.session.append('sandbox/roots-requested', { roots: preview.roots })
        if (change === 'fs-provider') { await fsFiber.dispose(); await ctx.plugin(SandboxedFileSystem, { cwd: primary }) }
        if (change === 'sandbox-provider') { await sandboxFiber.dispose(); await ctx.plugin(SupportedSandbox) }
        release.resolve(undefined)
        await rejected
        expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
      } finally {
        release.resolve(undefined)
        await Promise.allSettled([confirming, rejected])
      }
    },
  )

  it('does not transfer grants to imported histories, forks, or child Agent contexts', async () => {
    const { ctx, agent, call } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })
    const imported = ctx.sessions.create(SessionId('imported-approval'), {
      meta: { cwd: agent.session.header.cwd }, seed: agent.session.snapshotEvents(),
    })
    const fork = ctx.sessions.fork(agent.session, SessionSeq(agent.session.seq - 1), SessionId('forked-approval'))
    const { agent: child } = await ctx.agents.create({ sessionId: SessionId('child-no-grants'), parentAgent: agent,
      meta: { cwd: agent.session.header.cwd } })
    for (const session of [imported, fork, child.session]) {
      expect(ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots).toBeUndefined()
    }
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toHaveLength(1)
  })

  it('uses the Agent policy scope rather than the controller deployment', async () => {
    const { ctx, agent, call } = await fixture(true)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('workspace-write')
    expect(agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode).toBe('read-only')
    await expect(call('prepareRoots', { request: { sessionId: agent.id } })).rejects.toThrow(/does not support/)
    setSandboxMode(agent.session, 'workspace-write')
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })
    expect(agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).additionalWritableRoots).toHaveLength(1)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it('binds confirmation and active permissions to the Agent policy generation', async () => {
    const { ctx, agent, call, policyFiber, ownerCtx, primary } = await fixture(true)
    setSandboxMode(agent.session, 'workspace-write')
    const initial = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: initial.nonce } })
    const stale = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    const previous = agent.ctx.get('sandboxPolicy')
    await policyFiber?.dispose()
    await ownerCtx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: primary })
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: stale.nonce } })).rejects.toThrow()
    expect(previous?.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
    expect(agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it('does not reuse previews or active grants for replacement Agent and Session instances with the same id', async () => {
    const { ctx, agent, handle, call, primary } = await fixture()
    const initial = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: initial.nonce } })
    const stale = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await handle.dispose()
    const replacement = await ctx.agents.create({ sessionId: agent.id, meta: { cwd: primary }, seed: agent.session.snapshotEvents() })
    expect(replacement.agent).not.toBe(agent)
    expect(replacement.agent.session).not.toBe(agent.session)
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: stale.nonce } })).rejects.toThrow()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve({ session: replacement.agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it.each(['fs', 'sandbox'] as const)('invalidates previews and grants when the actual %s provider is replaced', async (kind) => {
    const { ctx, agent, call, fsFiber, sandboxFiber, primary } = await fixture()
    const initial = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: initial.nonce } })
    const stale = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    if (kind === 'fs') {
      await fsFiber.dispose()
      await ctx.plugin(SandboxedFileSystem, { cwd: primary })
    } else {
      await sandboxFiber.dispose()
      await ctx.plugin(SupportedSandbox)
    }
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: stale.nonce } })).rejects.toThrow()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

  it('fails closed when the descendant activity provider is unloaded after preview', async () => {
    const { ctx, agent, call, subagentFiber } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await subagentFiber.dispose()
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
    await expect(call('prepareRoots', { request: { sessionId: agent.id } })).rejects.toThrow()
  })

  it('refuses a directory replaced by a symlink both at confirmation and actual use', async () => {
    const { ctx, agent, call, source, reference } = await fixture()
    const preview = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await rename(source, source + '-saved')
    await symlink(reference, source, 'dir')
    await expect(call('confirmRoots', { request: { sessionId: agent.id, nonce: preview.nonce } })).rejects.toThrow()
    await rm(source)
    await rename(source + '-saved', source)
    const fresh = await call('prepareRoots', { request: { sessionId: agent.id } }) as RootApprovalPreview
    await call('confirmRoots', { request: { sessionId: agent.id, nonce: fresh.nonce } })
    await rename(source, source + '-saved')
    await symlink(reference, source, 'dir')
    const target = await ctx.fs.resolve(join(source, 'must-not-write.txt'))
    await expect(ctx.fs.writeText(target, 'no', undefined, undefined,
      ctx.sandboxPolicy.resolve({ session: agent.session }))).rejects.toThrow()
  })

  it('refuses an unsupported backend before issuing a usable preview', async () => {
    const { ctx, agent, call } = await fixture()
    vi.spyOn(ctx.sandbox, 'supportsAdditionalWritableRoots').mockReturnValue(false)
    await expect(call('prepareRoots', { request: { sessionId: agent.id } })).rejects.toThrow(/does not support/)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).additionalWritableRoots).toBeUndefined()
  })

})
