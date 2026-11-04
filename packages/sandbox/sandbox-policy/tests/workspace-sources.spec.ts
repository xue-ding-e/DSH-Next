/** Workspace source grants follow current registry membership at each policy resolution. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, type TestContext } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'

interface WorkspaceView {
  readonly sessionIds: readonly SessionId[]
  readonly sourcePaths: readonly string[]
}

function session(id: string, cwd: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    cwd,
  })
}

async function mounted(
  { onTestFinished }: TestContext,
  workspaces: readonly WorkspaceView[],
  additionalWritableRoots?: string[],
) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let current = workspaces
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('workspaceRegistry', { list: () => current } as never)
  await ctx.plugin(SandboxPolicyService, {
    mode: 'workspace-write', workspaceRoot: '/fallback',
    ...additionalWritableRoots === undefined ? {} : { additionalWritableRoots },
  })
  return { ctx, setWorkspaces: (next: readonly WorkspaceView[]) => { current = next } }
}

describe('SandboxPolicyService Workspace source grants', () => {
  it('merges current source directories with explicit roots and deduplicates them', async (test) => {
    const active = session('source-owner', '/work/primary')
    const { ctx } = await mounted(test, [
      { sessionIds: [active.id], sourcePaths: ['/work/primary', '/work/secondary'] },
    ], ['/deployment', '/work/secondary', '/deployment'])
    expect(ctx.sandboxPolicy.resolve({ session: active })).toEqual({
      mode: 'workspace-write', workspaceRoot: '/work/primary',
      additionalWritableRoots: ['/deployment', '/work/secondary'], sessionId: active.id,
    })
    expect(Object.isFrozen(ctx.sandboxPolicy.resolve({ session: active }).additionalWritableRoots)).toBe(true)
  })

  it('uses only the Workspace that currently owns the Session', async (test) => {
    const active = session('source-owner', '/work/primary')
    const unrelated = session('unrelated', '/work/unrelated')
    const { ctx } = await mounted(test, [
      { sessionIds: [active.id], sourcePaths: ['/work/primary', '/work/secondary'] },
      { sessionIds: [unrelated.id], sourcePaths: ['/work/unrelated', '/work/other'] },
    ])
    expect(ctx.sandboxPolicy.resolve({ session: active }).additionalWritableRoots).toEqual(['/work/secondary'])
    expect(ctx.sandboxPolicy.resolve({ session: unrelated }).additionalWritableRoots).toEqual(['/work/other'])
    expect(ctx.sandboxPolicy.resolve({ session: session('unlisted', '/work/primary') }).additionalWritableRoots).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve().additionalWritableRoots).toBeUndefined()
  })

  it('does not derive source grants for other modes and withdraws removed sources', async (test) => {
    const active = session('source-owner', '/work/primary')
    const { ctx, setWorkspaces } = await mounted(test, [
      { sessionIds: [active.id], sourcePaths: ['/work/primary', '/work/secondary'] },
    ], ['/deployment'])
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'read-only' }).additionalWritableRoots).toEqual(['/deployment'])
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'danger-full-access' }).additionalWritableRoots).toEqual(['/deployment'])
    setWorkspaces([{ sessionIds: [active.id], sourcePaths: ['/work/primary'] }])
    expect(ctx.sandboxPolicy.resolve({ session: active }).additionalWritableRoots).toEqual(['/deployment'])
    setWorkspaces([])
    expect(ctx.sandboxPolicy.resolve({ session: active }).additionalWritableRoots).toEqual(['/deployment'])
  })
})
