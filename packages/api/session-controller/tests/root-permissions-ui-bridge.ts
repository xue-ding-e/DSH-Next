/** Real Host fixture behind a pure wire test boundary for the DOM compiler face. */
import { Peer } from '@deepseek-ai/dsh-client-connection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import WorkspaceController from '../../workspace-controller/src/index.ts'
import { workspaceView } from '../../workspace-controller/src/feed.ts'
import { TYPERT as WORKSPACE_TYPERT } from '../../workspace-controller/lib/typert.host.js'
import type { WorkspaceValue } from '../../workspace-controller/src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { cleanupRootPermissionsFixture, rootPermissionsFixture, SupportedSandbox } from './root-permissions-fixture.ts'
import type { DirectoryHostFactory } from './root-permissions-wire.ts'

export const createDirectoryHost: DirectoryHostFactory = async () => {
  const fixture = await rootPermissionsFixture()
  const { ctx, call, source, reference, primary } = fixture
  let handle = fixture.handle
  return {
    sessionId: handle.agent.id, source, reference, primary,
    async invoke(method, request, signal) {
      try { return { ok: true, value: await call(method, { request }, fixture.peer, signal) } }
      catch (error) { return { ok: false, error: remoteErrorOf(error)
        ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) } }
    },
    async invokeOther(method, request) {
      const peer = new Peer(ctx, { principal: { kind: 'owner' } })
      try { return { ok: true, value: await call(method, { request }, peer) } }
      catch (error) { return { ok: false, error: remoteErrorOf(error)
        ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) } }
      finally { await peer.dispose() }
    },
    lifecycle(listener) {
      const removed = ctx.on('api-session/removed', listener)
      const added = ctx.on('api-session/added', (summary) => { listener(summary.sessionId) })
      return () => { removed(); added() }
    },
    async probe(directory) {
      const target = await ctx.fs.resolve(join(directory === 'source' ? source : reference, 'ui-probe.txt'))
      const policy = handle.agent.ctx.get('sandboxPolicy')
      if (policy === undefined) throw new Error('Fixture Agent policy is unavailable')
      await ctx.fs.writeText(target, 'directory UI integration', undefined, undefined,
        policy.resolve({ session: handle.agent.session }))
    },
    mode(mode) { setSandboxMode(handle.agent.session, mode) },
    writeSupport(supported) { (ctx.sandbox as SupportedSandbox).supported = supported },
    async replaceSession() {
      const old = handle.agent
      const events = old.session.snapshotEvents()
      await handle.dispose()
      handle = await ctx.agents.create({ sessionId: old.id, meta: { cwd: primary }, seed: events })
    },
    async initializeWorkspace() {
      await ctx.plugin(Storage)
      ctx.storage.backend.register('memory', new MemoryStorageBackend())
      const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', domain)
      ctx.provide('storageDomain', domain)
      ctx.provide('sessionPersistence', { list: async () => [] } as never)
      await ctx.plugin(WorkspaceRegistry).await()
      ctx.typert.register(WORKSPACE_TYPERT)
      await ctx.plugin(WorkspaceController, { documentsDirectory: primary }).await()
      const workspace = await ctx.workspaceRegistry.create(primary)
      await workspace.attachSession(handle.agent.id)
      return workspaceView(workspace)
    },
    async invokeWorkspace(request) {
      try {
        const value = await ctx.typertGateway.invoke({ peer: fixture.peer, namespace: 'workspace', method: 'setRoots',
          args: { request } }) as WorkspaceValue
        return { ok: true, value: value.workspace }
      } catch (error) { return { ok: false, error: remoteErrorOf(error)
        ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) } }
    },
    removeSourceDirectory: () => rm(source, { recursive: true }),
    changed: listener => ctx.on('api-session/directories-changed', listener),
    dispose: cleanupRootPermissionsFixture,
  }
}
