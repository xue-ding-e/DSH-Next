/** Real services and synthetic filesystem paths; no model, user files, or uploaded bytes. */
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalFileReferences from '@deepseek-ai/dsh-file-reference-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess, { type RemoteAccessBinding, type RemoteAccessCondition } from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionFileReferences } from '../src/file-references.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'file-drop-test': { readonly kind: 'file-drop-test' } }
}
const principal: Principal = { kind: 'file-drop-test' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(crossRoot = false, accessInstalled = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const other = join(root, 'other')
  await mkdir(other)
  const path = join(root, 'notes.txt')
  await writeFile(path, 'synthetic only')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(LocalFileReferences)
  if (accessInstalled) await ctx.plugin(RemoteAccess)
  const makeAgent = (id: string, cwd: string): Agent => ({
    id: SessionId(id), session: ctx.sessions.create(SessionId(id), { meta: { cwd } }), ctx,
  }) as Agent
  const source = makeAgent('source', root)
  const target = makeAgent('target', crossRoot ? other : root)
  const detachSource = ctx.agents.enter(source, undefined)
  const detachTarget = ctx.agents.enter(target, undefined)
  cleanups.push(async () => { detachTarget(); detachSource() })
  const lookup = vi.fn(async (id: SessionId) => id === target.id ? target : source)
  ctx.typert.lookups.configure('agent', lookup)
  let grants: Extract<RemoteAccessBinding, { resource: { kind: 'session' } }>[] = [source.id, target.id].map(id => ({
    resource: { kind: 'session', id }, role: { name: 'test:reference', resource: 'session', actions: ['fileReferences/list', 'session/prompt', 'fileReferences/resolveDrop'] },
  }))
  if (accessInstalled) ctx.remoteAccess.registerPolicy('file-drop-test', { bindings: () => grants })
  new SessionFileReferences(ctx)
  const invocation: RemoteInvocation = {
    request: { namespace: 'fileReferences', method: 'resolveDrop', args: {} }, service: 'sessionFileReferences',
    peer: new Peer(ctx, { principal }), signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  const service = ctx.extend({ invocation }).sessionFileReferences
  const actualList = ctx.fileReferences.list.bind(ctx.fileReferences)
  const list = vi.spyOn(ctx.fileReferences, 'list')
  return { ctx, root, path, source, target, lookup, list, actualList, service,
    grantDrop: () => { grants = grants.map(binding => ({ ...binding, role: { ...binding.role, actions: [...binding.role.actions, 'fileReferences/resolveDrop'] } })) },
    revokeDrop: () => { grants = grants.map(binding => binding.resource.id !== target.id ? binding : { ...binding, role: { ...binding.role, actions: binding.role.actions.filter(action => action !== 'fileReferences/resolveDrop') } }) },
    revokeSource: () => { grants = grants.filter(binding => binding.resource.id !== source.id) },
    revoke: () => { grants = [] },
    requireArgs: () => { grants = grants.map(binding => ({ ...binding, condition: (({ args }) => args === undefined ? { kind: 'deny', reason: 'args-required' } : { kind: 'allow' }) satisfies RemoteAccessCondition<'session'> })) },
    resolve: (value = path, kind: 'file' | 'directory' = 'file', signal = new AbortController().signal) => service.resolveDrop(target, source.id, value, kind, signal),
  }
}

it('resolves the exact existing file and directory in both authorized scopes', async () => {
  const h = await setup()
  expect(await h.resolve()).toEqual({ path: h.path, kind: 'file' })
  expect(await h.resolve(join(h.root, 'other'), 'directory')).toEqual({ path: join(h.root, 'other'), kind: 'directory' })
  expect(h.list).toHaveBeenCalledTimes(4)
})

it('denies before source activation or discovery when access is missing', async () => {
  const h = await setup()
  h.revoke()
  await expect(h.resolve()).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  expect(h.lookup).not.toHaveBeenCalled()
  expect(h.list).not.toHaveBeenCalled()
})

it('does not reinterpret a source path inside a different destination workspace', async () => {
  const h = await setup(true)
  await writeFile(join(h.root, 'other', 'notes.txt'), 'different synthetic file')
  await expect(h.resolve()).rejects.toMatchObject({ code: 'file-reference/unavailable' })
})

it('rejects removed, renamed, mismatched-kind and unsafe paths', async () => {
  const h = await setup()
  await expect(h.resolve(h.path, 'directory')).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  await rename(h.path, join(h.root, 'renamed.txt'))
  for (const value of [h.path, 'notes.txt', h.path + '\0', join(h.root, 'missing')]) {
    await expect(h.resolve(value)).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  }
})

it('rejects symlink entries and symlink ancestors without following them', async () => {
  const h = await setup()
  const link = join(h.root, 'link.txt')
  await symlink(h.path, link)
  await expect(h.resolve(link)).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  const directory = join(h.root, 'linked-dir')
  await symlink(join(h.root, 'other'), directory, 'dir')
  await writeFile(join(h.root, 'other', 'child.txt'), 'synthetic child')
  await expect(h.resolve(join(directory, 'child.txt'))).rejects.toMatchObject({ code: 'file-reference/unavailable' })
})

it('keeps binary and large files path-only rather than reading or uploading contents', async () => {
  const h = await setup()
  const binary = join(h.root, 'binary.dat')
  const large = join(h.root, 'large.dat')
  await writeFile(binary, Buffer.from([0, 255, 0]))
  await writeFile(large, '')
  await truncate(large, 1024 * 1024 * 1024)
  expect(await h.resolve(binary)).toEqual({ path: binary, kind: 'file' })
  expect(await h.resolve(large)).toEqual({ path: large, kind: 'file' })
})

it('rechecks source revocation after lookup and does not publish a candidate', async () => {
  const h = await setup()
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<Agent>()
  h.lookup.mockImplementation(() => { entered.resolve(undefined); return gate.promise })
  const pending = h.resolve()
  const rejected = expect(pending).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  try { await entered.promise; h.revoke(); gate.resolve(h.source); await rejected; expect(h.list).not.toHaveBeenCalled() }
  finally { gate.resolve(h.source); await pending.catch(() => undefined) }
})

it('honors cancellation before any source activation', async () => {
  const h = await setup()
  const controller = new AbortController()
  controller.abort()
  await expect(h.resolve(h.path, 'file', controller.signal)).rejects.toThrow()
  expect(h.lookup).not.toHaveBeenCalled()
  expect(h.list).not.toHaveBeenCalled()
})


it('does not treat an argument-limited listing grant as full path discovery permission', async () => {
  const h = await setup()
  h.requireArgs()
  await expect(h.resolve()).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  expect(h.lookup).not.toHaveBeenCalled()
  expect(h.list).not.toHaveBeenCalled()
})

it.each([1, 2])('rechecks revocation while discovery call %i is pending', async (deferredCall) => {
  const h = await setup()
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const actual = h.actualList
  let calls = 0
  h.list.mockImplementation(async (...args) => {
    const result = await actual(...args)
    if (++calls === deferredCall) { entered.resolve(undefined); await gate.promise }
    return result
  })
  const pending = h.resolve()
  const rejected = expect(pending).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  try { await entered.promise; h.revoke(); gate.resolve(undefined); await rejected }
  finally { gate.resolve(undefined); await pending.catch(() => undefined) }
  expect(h.list).toHaveBeenCalledTimes(deferredCall)
})


it('fails closed for a non-owner without the optional access service but preserves local owner discovery', async () => {
  const h = await setup(false, false)
  await expect(h.resolve()).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  expect(h.lookup).not.toHaveBeenCalled()
  expect(h.list).not.toHaveBeenCalled()
  expect(await h.ctx.sessionFileReferences.resolveDrop(h.target, h.source.id, h.path, 'file', new AbortController().signal)).toEqual({ path: h.path, kind: 'file' })
})


it('enforces the new endpoint grant through the real Gateway before resolving and staging metadata', async () => {
  const h = await setup()
  h.revokeDrop()
  await h.ctx.plugin(TypertGateway)
  const peer = new Peer(h.ctx, { principal })
  const call = () => h.ctx.typertGateway.invoke({ peer, namespace: 'fileReferences', method: 'resolveDrop', args: {
    agentId: h.target.id, sourceSessionId: h.source.id, path: h.path, kind: 'file',
  } })
  await expect(call()).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(h.lookup).not.toHaveBeenCalled()
  expect(h.list).not.toHaveBeenCalled()
  h.grantDrop()
  await expect(call()).resolves.toEqual({ path: h.path, kind: 'file' })
  h.lookup.mockClear()
  h.list.mockClear()
  h.revokeSource()
  await expect(call()).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  expect(h.lookup).toHaveBeenCalledTimes(1)
  expect(h.lookup).toHaveBeenCalledWith(h.target.id)
  expect(h.list).not.toHaveBeenCalled()
})


it.each(['lookup', 'source-list', 'target-list'] as const)('rejects endpoint-only revocation during deferred %s through the real Gateway', async (phase) => {
  const h = await setup()
  await h.ctx.plugin(TypertGateway)
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  if (phase === 'lookup') {
    h.lookup.mockImplementation(async (id) => {
      if (id === h.source.id) { entered.resolve(undefined); await gate.promise }
      return id === h.target.id ? h.target : h.source
    })
  } else {
    h.list.mockImplementation(async (...args) => {
      const result = await h.actualList(...args)
      if (args[0].id === (phase === 'source-list' ? h.source.id : h.target.id)) {
        entered.resolve(undefined)
        await gate.promise
      }
      return result
    })
  }
  const pending = h.ctx.typertGateway.invoke({ peer: new Peer(h.ctx, { principal }), namespace: 'fileReferences', method: 'resolveDrop', args: {
    agentId: h.target.id, sourceSessionId: h.source.id, path: h.path, kind: 'file',
  } })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  try {
    await entered.promise
    h.revokeDrop()
    for (const [id, action] of [[h.source.id, 'fileReferences/list'], [h.target.id, 'fileReferences/list'], [h.target.id, 'session/prompt']] as const) {
      expect(h.ctx.remoteAccess.decide({ principal, action, resources: [{ kind: 'session', id }] })).toEqual({ kind: 'allow' })
    }
    gate.resolve(undefined)
    await rejected
    expect(h.list).toHaveBeenCalledTimes(phase === 'lookup' ? 0 : phase === 'source-list' ? 1 : 2)
  } finally { gate.resolve(undefined); await pending.catch(() => undefined) }
})
