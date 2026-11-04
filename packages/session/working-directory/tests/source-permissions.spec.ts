/** Source directories are checked through the same filesystem policy used by mutations. */

import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, type TestContext } from 'vitest'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SandboxPolicy, { setSandboxMode, type Config } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

async function fixture(
  { onTestFinished }: TestContext,
  config: (root: string) => Config = root => ({ mode: 'workspace-write', workspaceRoot: join(root, 'primary') }),
) {
  const ctx = new Context()
  // Temp descendants inherit automatic write grants, which would hide a missing source grant or denial.
  const allocated = await mkdtemp(join(outsideTempWorkspaceParent(), 'dsh-policy-sources-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(allocated, { recursive: true, force: true })
  })
  const root = await realpath(allocated)
  assertWorkspaceOutsideTemp(root)
  const primary = join(root, 'primary')
  const secondary = join(root, 'secondary')
  const replacement = join(root, 'replacement')
  const deployment = join(root, 'deployment')
  const unlisted = join(root, 'unlisted')
  await Promise.all([primary, secondary, replacement, deployment, unlisted].map(path => mkdir(path)))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicy, config(root))
  await ctx.plugin(SandboxedFileSystem, { cwd: primary })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  const registryFiber = await ctx.plugin(WorkspaceRegistry)
  const active = ctx.sessions.create(SessionId('source-owner'), { meta: { cwd: primary } })
  const workspace = await ctx.workspaceRegistry.create(primary)
  await workspace.configure('Sources', [primary, secondary])
  await workspace.attachSession(active.id)
  return { ctx, primary, secondary, replacement, deployment, unlisted, active, workspace, registryFiber }
}

describe('Workspace source write permissions', () => {
  it('allows a configured sibling and denies unlisted or unowned sources', async (test) => {
    const f = await fixture(test)
    const other = await f.ctx.workspaceRegistry.create(f.unlisted)
    await other.configure('Other sources', [f.unlisted, f.replacement])
    const otherSession = f.ctx.sessions.create(SessionId('other-owner'), { meta: { cwd: f.unlisted } })
    await other.attachSession(otherSession.id)
    const policy = f.ctx.sandboxPolicy.resolve({ session: f.active })
    expect(policy.workspaceRoot).toBe(f.primary)
    expect(policy.additionalWritableRoots).toEqual([f.secondary])
    const allowed = join(f.secondary, 'allowed.txt')
    await f.ctx.fs.writeText(await f.ctx.fs.resolve(allowed), 'allowed', undefined, undefined, policy)
    expect(await readFile(allowed, 'utf8')).toBe('allowed')
    const denied = join(f.unlisted, 'denied.txt')
    await expect(f.ctx.fs.writeText(await f.ctx.fs.resolve(denied), 'denied', undefined, undefined, policy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(readFile(denied)).rejects.toMatchObject({ code: 'ENOENT' })
    const unrelated = f.ctx.sessions.create(SessionId('unowned'), { meta: { cwd: f.primary } })
    const unownedPolicy = f.ctx.sandboxPolicy.resolve({ session: unrelated })
    expect(unownedPolicy.additionalWritableRoots).toBeUndefined()
    await expect(f.ctx.fs.writeText(await f.ctx.fs.resolve(allowed), 'denied', undefined, undefined, unownedPolicy))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(allowed, 'utf8')).toBe('allowed')
    expect(f.ctx.sandboxPolicy.resolve({ session: otherSession }).additionalWritableRoots).toEqual([f.replacement])
  })

  it('merges explicit roots, keeps them after source removal, and withdraws registry grants on unload', async (test) => {
    const f = await fixture(test, root => ({
      mode: 'workspace-write', workspaceRoot: join(root, 'primary'),
      additionalWritableRoots: [join(root, 'deployment'), join(root, 'deployment')],
    }))
    const policy = f.ctx.sandboxPolicy.resolve({ session: f.active })
    expect(policy.additionalWritableRoots).toEqual([f.deployment, f.secondary])
    expect(Object.isFrozen(policy.additionalWritableRoots)).toBe(true)
    const path = join(f.deployment, 'explicit.txt')
    await f.ctx.fs.writeText(await f.ctx.fs.resolve(path), 'explicit', undefined, undefined, policy)
    expect(await readFile(path, 'utf8')).toBe('explicit')
    await f.workspace.configure('Primary only', [f.primary])
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active }).additionalWritableRoots).toEqual([f.deployment])
    await f.workspace.configure('Sources again', [f.primary, f.secondary])
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active }).additionalWritableRoots).toEqual([f.deployment, f.secondary])
    await f.registryFiber.dispose()
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active }).additionalWritableRoots).toEqual([f.deployment])
    await f.ctx.plugin(WorkspaceRegistry)
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active }).additionalWritableRoots).toEqual([f.deployment, f.secondary])
  })

  it('revokes a removed sibling grant while preserving Sessions rooted in that historical source across reload', async (test) => {
    const f = await fixture(test)
    const secondarySession = f.ctx.sessions.create(SessionId('secondary-owner'), { meta: { cwd: f.secondary } })
    await f.workspace.attachSession(secondarySession.id)
    const path = join(f.secondary, 'source.txt')
    await f.ctx.fs.writeText(await f.ctx.fs.resolve(path), 'original', undefined, undefined,
      f.ctx.sandboxPolicy.resolve({ session: f.active }))
    await f.workspace.configure('Replacement source', [f.primary, f.replacement])
    expect(f.workspace.sessionIds).toContain(secondarySession.id)
    const changed = f.ctx.sandboxPolicy.resolve({ session: f.active })
    expect(changed).toMatchObject({ workspaceRoot: f.primary, additionalWritableRoots: [f.replacement] })
    await expect(f.ctx.fs.writeText(await f.ctx.fs.resolve(path), 'denied', undefined, undefined, changed))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
    const secondaryPolicy = f.ctx.sandboxPolicy.resolve({ session: secondarySession })
    expect(secondaryPolicy).toMatchObject({
      workspaceRoot: f.secondary, additionalWritableRoots: [f.primary, f.replacement],
    })
    await f.ctx.fs.writeText(await f.ctx.fs.resolve(path), 'own root', undefined, undefined, secondaryPolicy)
    expect(await readFile(path, 'utf8')).toBe('own root')
    await f.registryFiber.dispose()
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active }).additionalWritableRoots).toBeUndefined()
    await f.ctx.plugin(WorkspaceRegistry)
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active })).toEqual(changed)
    expect(f.ctx.sandboxPolicy.resolve({ session: secondarySession })).toEqual(secondaryPolicy)
    const reloaded = f.ctx.workspaceRegistry.get(f.workspace.id)
    if (reloaded === undefined) throw new Error('Workspace was not restored')
    await reloaded.configure('Primary only', [f.primary])
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active }).additionalWritableRoots).toBeUndefined()
    expect(f.active.header.cwd).toBe(f.primary)
    expect(secondarySession.header.cwd).toBe(f.secondary)
  })

  it('keeps every source nonwritable under read-only and honors the next effective mode', async (test) => {
    const f = await fixture(test, root => ({
      mode: 'read-only', workspaceRoot: join(root, 'primary'), additionalWritableRoots: [join(root, 'deployment')],
    }))
    const readOnly = f.ctx.sandboxPolicy.resolve({ session: f.active })
    expect(readOnly.additionalWritableRoots).toEqual([f.deployment])
    for (const directory of [f.primary, f.secondary, f.deployment]) {
      const path = join(directory, 'readonly.txt')
      await expect(f.ctx.fs.writeText(await f.ctx.fs.resolve(path), 'denied', undefined, undefined, readOnly))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const approved = f.ctx.sandboxPolicy.resolve({ session: f.active, mode: 'workspace-write' })
    expect(approved.additionalWritableRoots).toEqual([f.deployment, f.secondary])
    const allowed = join(f.secondary, 'approved.txt')
    await f.ctx.fs.writeText(await f.ctx.fs.resolve(allowed), 'approved', undefined, undefined, approved)
    expect(await readFile(allowed, 'utf8')).toBe('approved')
    setSandboxMode(f.active, 'read-only')
    expect(f.ctx.sandboxPolicy.resolve({ session: f.active })).toEqual(readOnly)
  })
})
