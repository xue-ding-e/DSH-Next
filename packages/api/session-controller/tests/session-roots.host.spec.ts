import { Context, type Fiber } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { KNOWN_SESSION_EVENT_TYPES, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { restoreReleasedV4Artifact } from '../../../session/session-format-v3-to-v4/src/index.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { installSessionReadTestServices } from './test-remote.ts'

// Replace only the unavailable OS flock entry, using the lease suite's mock seam.
// JSONL files, codecs, handles and lifecycle stay real. This does NOT verify native locks.
vi.mock('@deepseek-ai/node-addon-system/flock', () => ({
  tryLockExclusive: vi.fn<(_fd: number) => Promise<void>>().mockResolvedValue(undefined),
}))

const contexts: Context[] = []
const loops: Fiber[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(loops.splice(0).map(fiber => fiber.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture(persistenceRoot?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-session-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot ?? join(root, 'logs'), compression: 'none' })
  const loop = ctx.plugin(AgentLoop, { agents: [] })
  await loop
  loops.push(loop)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  installSessionReadTestServices(ctx)
  const controller = new ApiSessionAgentController(ctx)
  controller.initialize()
  return { ctx, controller, root, loop, persistenceRoot: persistenceRoot ?? join(root, 'logs') }
}

describe('Session root capture through real Agent creation', () => {
  it('captures before publication and does not replace roots when a blank Session is reused', async () => {
    const { ctx, controller, root } = await fixture()
    const requestedRoots = [{ path: join(root, 'reference'), access: 'reference' as const }]
    const announced: unknown[] = []
    ctx.on('agent/created', ({ agent }) => { announced.push(ctx.sandboxPolicy.requestedRootsOf(agent.session)) })
    const created = await controller.createSession({ cwd: root, requestedRoots, reusable: () => true })
    expect(announced).toEqual([requestedRoots])
    expect(ctx.sandboxPolicy.resolve({ session: created.agent.session })).not.toHaveProperty('additionalWritableRoots')
    const reused = await controller.createSession({ sessionId: created.agent.id, cwd: root,
      requestedRoots: [{ path: join(root, 'new-default'), access: 'write' }], reusable: () => true })
    expect(reused.agent).toBe(created.agent)
    expect(ctx.sandboxPolicy.requestedRootsOf(reused.agent.session)).toEqual(requestedRoots)
    expect(announced).toHaveLength(1)
  })

  it('detaches defaults before asynchronous composition', async () => {
    const { ctx, controller, root } = await fixture()
    const composition = await controller.composeAgent(undefined)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(controller, 'composeAgent').mockImplementation(async () => { entered.resolve(undefined); await release.promise; return composition })
    const requestedRoots = [{ path: join(root, 'original'), access: 'reference' as const }]
    const creating = controller.createSession({ cwd: root, requestedRoots, reusable: () => true })
    await entered.promise
    requestedRoots[0]!.path = join(root, 'changed')
    expect(ctx.agents.list()).toEqual([])
    release.resolve(undefined)
    const created = await creating
    expect(ctx.sandboxPolicy.requestedRootsOf(created.agent.session)).toEqual([{ path: join(root, 'original'), access: 'reference' }])
  })

  it('does not publish an executable Agent when root capture fails', async () => {
    const { ctx, controller, root } = await fixture()
    const announce = vi.fn()
    ctx.on('agent/created', announce)
    const sessionId = SessionId('failed-root-capture')
    await expect(controller.createSession({ sessionId, cwd: root,
      requestedRoots: [{ path: 'relative', access: 'write' }], reusable: () => true })).rejects.toThrow(/Invalid input/)
    expect(ctx.agents.list()).toEqual([])
    expect(announce).not.toHaveBeenCalled()
    // This failed setup has no flushed events, so JSONL does not list it.
    expect(await ctx.sessionPersistence.list()).toHaveLength(0)
    const resumed = await controller.createSession({ sessionId, cwd: root,
      requestedRoots: [{ path: join(root, 'later-default'), access: 'write' }], reusable: () => true })
    expect(ctx.sandboxPolicy.requestedRootsOf(resumed.agent.session)).toEqual([
      { path: join(root, 'later-default'), access: 'write' },
    ])
    expect(ctx.sandboxPolicy.resolve({ session: resumed.agent.session })).not.toHaveProperty('additionalWritableRoots')
  })

  it('restores a real JSONL request without granting writes and refuses it for an old reader', async () => {
    const original = await fixture()
    const createStored = vi.spyOn(original.ctx.sessionPersistence, 'create')
    const created = await original.controller.createSession({ cwd: original.root,
      requestedRoots: [{ path: join(original.root, 'missing-source'), access: 'write' }], reusable: () => true })
    expect(createStored).toHaveBeenCalledOnce()
    expect(await original.ctx.sessionPersistence.list()).toHaveLength(1)
    const id = created.agent.id
    const header = created.agent.session.header
    await original.ctx.sessions.flush(created.agent.session)
    await original.loop.dispose()
    await original.ctx.fiber.dispose()
    const restored = await fixture(original.persistenceRoot)
    const handle = await restored.ctx.sessionPersistence.open(id, 'read')
    const read = await handle.read()
    await handle.close()
    const session = restored.ctx.sessions.create(id, { meta: header, seed: read.events })
    expect(restored.ctx.sandboxPolicy.requestedRootsOf(session)).toEqual([{ path: join(original.root, 'missing-source'), access: 'write' }])
    expect(restored.ctx.sandboxPolicy.resolve({ session })).not.toHaveProperty('additionalWritableRoots')
    const oldVocabulary = new Set([...KNOWN_SESSION_EVENT_TYPES].filter(type => type !== 'sandbox/roots-requested'))
    const artifact = { header: { ...header, delegationDepth: header.delegationDepth ?? 0 }, events: read.events, inheritedEventCount: 0 }
    expect(() => restoreReleasedV4Artifact(artifact, oldVocabulary)).toThrow(/unknown event type/)
  })

  it('forks the selected prefix without consulting later Workspace defaults', async () => {
    const { ctx, controller, root } = await fixture()
    const created = await controller.createSession({ cwd: root,
      requestedRoots: [{ path: join(root, 'at-creation'), access: 'reference' }], reusable: () => true })
    const event = created.agent.session.snapshotEvents().find(event => event.type === 'sandbox/roots-requested')!
    const child = ctx.sessions.fork(created.agent.session, SessionSeq(event.seq), SessionId('root-prefix-child'))
    expect(ctx.sandboxPolicy.requestedRootsOf(child)).toEqual([{ path: join(root, 'at-creation'), access: 'reference' }])
    expect(ctx.sandboxPolicy.resolve({ session: child })).not.toHaveProperty('additionalWritableRoots')
    expect(child.header.cwd).toBe(root)
  })
})
