/** Owner directory defaults through generated Gateway codecs and durable Workspace storage. */
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it } from 'vitest'
import { cleanupRootPermissionsFixture, rootPermissionsFixture } from '../../session-controller/tests/root-permissions-fixture.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceController from '../src/index.ts'
import { workspaceView } from '../src/feed.ts'
import { TYPERT } from '../lib/typert.host.js'
import type { WorkspaceValue } from '../src/types.ts'

afterEach(cleanupRootPermissionsFixture)

it('saves defaults through an owner Peer, preserves primary and existing Session roots, and rejects a guest', async () => {
  const { ctx, peer, agent, primary, source, reference } = await rootPermissionsFixture()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  // No persisted Session history is needed for the defaults-only Workspace fixture.
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  await ctx.plugin(WorkspaceRegistry).await()
  ctx.typert.register(TYPERT)
  await ctx.plugin(WorkspaceController, { documentsDirectory: primary })
  const workspace = await ctx.workspaceRegistry.create(primary)
  const before = ctx.sandboxPolicy.requestedRootsOf(agent.session)
  const roots = [{ path: reference, access: 'reference' as const }]
  const result = await ctx.typertGateway.invoke({ peer, namespace: 'workspace', method: 'setRoots',
    args: { request: { workspaceId: workspace.id, roots } } }) as WorkspaceValue
  expect(result.workspace.additionalRoots).toEqual(roots)
  expect(workspaceView(workspace).additionalRoots).toEqual(roots)
  expect(workspace.path).toBe(primary)
  expect(ctx.sandboxPolicy.requestedRootsOf(agent.session)).toEqual(before)
  expect(ctx.sandboxPolicy.confirmedRootsOf(agent.session)).toEqual([])
  const guest = new Peer(ctx, { principal: { kind: 'root-test-guest' } })
  ctx.remoteAccess.registerPolicy('root-test-guest', { bindings: () => [{
    role: { name: 'defaults-all', resource: 'workspace', actions: ['workspace/setRoots'] },
    resource: { kind: 'workspace', id: workspace.id },
  }] })
  try {
    await expect(ctx.typertGateway.invoke({ peer: guest, namespace: 'workspace', method: 'setRoots',
      args: { request: { workspaceId: workspace.id, roots: [{ path: source, access: 'write' }] } } }))
      .rejects.toMatchObject({ code: 'workspace/roots-owner-required' })
    expect(workspace.additionalRoots).toEqual(roots)
  } finally { await guest.dispose() }
})
