/** Directory confirmation through the real Gateway, Peer, Agent and file sandbox. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import { SandboxProvider, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import Subagents from '@deepseek-ai/dsh-subagent'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Terminals from '@deepseek-ai/dsh-terminal'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'
import { createSessionTestController } from './test-remote.ts'
import { TYPERT } from '../lib/typert.host.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'root-test-guest': { readonly kind: 'root-test-guest' }
  }
}

export class SupportedSandbox extends SandboxProvider {
  supported = true
  override supportsAdditionalWritableRoots(mode: SandboxMode): boolean { return this.supported && mode === 'workspace-write' }
  override confine(): Promise<never> { throw new Error('No process execution in this fixture') }
}
const cleanup: Array<() => Promise<void>> = []
export async function cleanupRootPermissionsFixture(): Promise<void> {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
}
export async function rootPermissionsFixture(scopedPolicy = false) {
  const base = await realpath(await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-root-approval-')))
  assertWorkspaceOutsideTemp(base)
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const primary = join(base, 'primary'), source = join(base, 'source'), reference = join(base, 'reference')
  await Promise.all([primary, source, reference].map(path => mkdir(path)))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  ctx.typert.register(validateTypertManifest('@deepseek-ai/dsh-api-session-controller', TYPERT))
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
