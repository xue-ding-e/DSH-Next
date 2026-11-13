import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it } from 'vitest'
import SandboxPolicyService from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/fallback' })
  const session = ctx.sessions.create(SessionId('roots-owner'), { meta: { cwd: '/primary' } })
  return { ctx, session }
}

describe('unapproved Session root requests', () => {
  it('captures a detached snapshot without changing effective write policy', async () => {
    const { ctx, session } = await fixture()
    const roots = [{ path: '/source', access: 'write' as const }]
    const before = ctx.sandboxPolicy.resolve({ session })
    ctx.sandboxPolicy.initializeRequestedRoots(session, roots)
    roots[0]!.path = '/later-workspace-default'
    expect(ctx.sandboxPolicy.requestedRootsOf(session)).toEqual([{ path: '/source', access: 'write' }])
    expect(ctx.sandboxPolicy.resolve({ session })).toEqual(before)
    expect(session.header.cwd).toBe('/primary')
    expect(session.snapshotEvents()).toContainEqual(expect.objectContaining({ type: 'sandbox/roots-requested', data: { roots: [{ path: '/source', access: 'write' }] } }))
    expect(session.snapshotEvents().some(event => event.ignorable === true)).toBe(false)
  })
  it('keeps old Sessions empty and rejects recapture or capture after a turn starts', async () => {
    const { ctx, session } = await fixture()
    expect(ctx.sandboxPolicy.requestedRootsOf(session)).toBeNull()
    ctx.sandboxPolicy.initializeRequestedRoots(session, [])
    expect(() => { ctx.sandboxPolicy.initializeRequestedRoots(session, [{ path: '/later', access: 'reference' }]) }).toThrow(/already/)
    const started = ctx.sessions.create(SessionId('started'), { meta: { cwd: '/primary' } })
    started.append('turn/start', { turn: 1 })
    expect(() => { ctx.sandboxPolicy.initializeRequestedRoots(started, []) }).toThrow(/started/)
  })
  it('restores imported and fork-prefix requests only as unapproved metadata', async () => {
    const { ctx, session } = await fixture()
    const before = session.snapshotEvents()
    ctx.sandboxPolicy.initializeRequestedRoots(session, [{ path: '/external', access: 'write' }])
    const imported = ctx.sessions.create(SessionId('imported'), { meta: { cwd: '/primary' }, seed: session.snapshotEvents() })
    const earlier = ctx.sessions.create(SessionId('earlier-cut'), { meta: { cwd: '/primary' }, seed: before })
    expect(ctx.sandboxPolicy.requestedRootsOf(imported)).toEqual([{ path: '/external', access: 'write' }])
    expect(ctx.sandboxPolicy.requestedRootsOf(earlier)).toBeNull()
    expect(ctx.sandboxPolicy.resolve({ session: imported })).not.toHaveProperty('additionalWritableRoots')
    expect(ctx.sandboxPolicy.resolve({ session: earlier })).not.toHaveProperty('additionalWritableRoots')
  })
})
