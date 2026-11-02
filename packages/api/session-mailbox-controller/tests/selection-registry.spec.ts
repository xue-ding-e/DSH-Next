import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { provideBrowserCredentials } from '../../../client/connection/tests/browser-credentials.ts'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as mailboxPlugin from '../src/index.ts'
import { SessionMailboxController } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision, type SessionHandle, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import type {} from '@deepseek-ai/dsh-agent'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { withHostMailbox, type HostMailboxConfig } from '@deepseek-ai/dsh-experimental-session-mailbox/host'
import type { MailboxRecord } from '@deepseek-ai/dsh-experimental-session-mailbox'
import { MailboxSelectionRegistry } from '../src/selection-registry.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'mailbox-test-guest': { readonly kind: 'mailbox-test-guest' }
  }
}
const artifact = fileURLToPath(new URL('../lib/typert.host.js', import.meta.url))
async function generatedContract() {
  const generated = await import(pathToFileURL(artifact).href) as { TYPERT: unknown }
  return validateTypertManifest('@deepseek-ai/dsh-api-session-mailbox-controller', generated.TYPERT)
}
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

class HeaderPersistence extends SessionPersistence {
  readonly records = new Map<SessionId, SessionHeader>()
  beforeStat: ((id: SessionId) => Promise<void>) | undefined
  create(): Promise<SessionHandle> { throw new Error('must not create a Session') }
  open(): Promise<SessionHandle> { throw new Error('must not restore or read Session history') }
  flush(): Promise<void> { return Promise.resolve() }
  async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    await this.beforeStat?.(id)
    const header = this.records.get(id)
    return header ? { header, revision: SessionPersistenceRevision('fixture-revision') } : undefined
  }
  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([...this.records.values()].map(header => ({ header, revision: SessionPersistenceRevision('fixture-revision') })))
  }
}
function scoped(ctx: Context, principal: Principal = { kind: 'owner' }, priorPeer?: PeerScope) {
  const peer = priorPeer ?? new Peer(ctx, { principal })
  const signal = new AbortController()
  const invocation: RemoteInvocation = {
    peer, signal: signal.signal, service: 'mailbox-test-host',
    request: { namespace: 'mailbox-test-host', method: 'selected', args: {} },
    uplink: <In>(): AsyncIterable<In> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
    }),
  }
  return { ctx: ctx.extend({ invocation }), peer, signal }
}
async function harness() {
  // Synthetic fixture only: no default profile, user Session, or credential directory.
  const root = await mkdtemp(join(tmpdir(), 'mailbox-product-fixture-'))
  vi.stubEnv('DSH_HOME', root)
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'registry'))
  ctx.storage.backend.register('json', backend)
  cleanups.push(() => backend.close())
  const facility = new DomainFacility(ctx, { backend: 'json' })
  cleanups.push(() => facility.closeAll())
  ctx.provide('storageDomain', facility)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(HeaderPersistence)
  await ctx.plugin(WorkspaceRegistry)
  ctx.sessions.create(A)
  ctx.sessions.create(B)
  const persistence = ctx.sessionPersistence as HeaderPersistence
  persistence.records.set(C, { id: C, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
  const config: HostMailboxConfig = { privateRoot: join(root, 'mailbox'), lockWaitMs: 0, maxRecords: 10, maxRecordBytes: 4096, selectionTtlMs: 1000 }
  const owner = scoped(ctx)
  return { ctx, config, owner, persistence, selection: new AbortController() }
}
function receipt(value: MailboxRecord | readonly MailboxRecord[]): MailboxRecord {
  if (Array.isArray(value)) throw new Error('expected receipt')
  return value as MailboxRecord
}

describe('browser route grants', () => {
  it('binds routes to the exact browser Peer and consumes operations only once', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const registry = new MailboxSelectionRegistry(h.owner.peer, adapter)
      try {
        const other = scoped(h.ctx)
        expect(() => registry.grant(other.ctx, { action: 'send', source: A, target: B })).toThrow()
        expect(() => registry.grant(h.ctx, { action: 'inbox', target: B })).toThrow()
        const grant = registry.grant(h.owner.ctx, { action: 'send', source: A, target: B })
        expect(() => registry.prepare(other.ctx, grant, { action: 'send', requestId: '1', text: 'x' })).toThrow()
        expect(() => registry.prepare(h.owner.ctx, grant, { action: 'inbox' })).toThrow()
        const selection = registry.prepare(h.owner.ctx, grant, { action: 'send', requestId: '1', text: '<script>untrusted</script>' })
        const first = registry.execute(h.owner.ctx, selection)
        await expect(registry.execute(h.owner.ctx, selection)).rejects.toThrow()
        const sent = receipt(await first)
        expect(sent).toMatchObject({ source: A, target: B, mode: 'queue-only' })
        const inboxGrant = registry.grant(h.owner.ctx, { action: 'inbox', target: B })
        const inbox = registry.prepare(h.owner.ctx, inboxGrant, { action: 'inbox' })
        expect(await registry.execute(h.owner.ctx, inbox)).toEqual([sent])
        const ackGrant = registry.grant(h.owner.ctx, { action: 'ack', target: B })
        const ack = registry.prepare(h.owner.ctx, ackGrant, { action: 'ack', id: sent.id })
        expect(await registry.execute(h.owner.ctx, ack)).toMatchObject({ status: 'acknowledged' })
        expect(h.ctx.get('agents')).toBeUndefined()
      } finally { registry.close() }
    })
  })

  it('revokes all prepared operations, enforces bounds, and denies expired routes', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      const registry = new MailboxSelectionRegistry(h.owner.peer, adapter)
      try {
        const route = { action: 'send' as const, source: A, target: B }
        const grant = registry.grant(h.owner.ctx, route)
        const selected = registry.prepare(h.owner.ctx, grant, { action: 'send', requestId: '2', text: 'no delivery' })
        registry.revoke(h.owner.ctx, grant)
        await expect(registry.execute(h.owner.ctx, selected)).rejects.toThrow()
        expect(() => registry.prepare(h.owner.ctx, grant, { action: 'send', requestId: '2', text: 'x' })).toThrow()
        const next = registry.grant(h.owner.ctx, route)
        expect(() => registry.prepare(h.owner.ctx, next, { action: 'send', requestId: '3', text: 'x'.repeat(16385) })).toThrow()
        now = 30_000
        expect(() => registry.prepare(h.owner.ctx, next, { action: 'send', requestId: '3', text: 'x' })).toThrow()
        for (let i = 0; i < 32; i++) registry.grant(h.owner.ctx, route)
        expect(() => registry.grant(h.owner.ctx, route)).toThrow()
      } finally { registry.close() }
      expect(() => registry.grant(h.owner.ctx, { action: 'inbox', target: B })).toThrow()
    })
  })
})

it.skipIf(!existsSync(artifact))('dispatches the generated Remote contract through real Gateway and Connection Peer identity', async () => {
  const h = await harness()
  provideBrowserCredentials(h.ctx)
  await h.ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await h.ctx.plugin(Gateway)
  h.ctx.typert.register(await generatedContract())
  await withHostMailbox(h.ctx, h.config, async (adapter) => {
    const controller = h.ctx.plugin(SessionMailboxController, adapter)
    await controller.await()
    try {
      const browser = h.ctx.connection.browserPeer
      const call = (peer: PeerScope, method: string, args: Record<string, unknown>) =>
        h.ctx.typertGateway.invoke({ peer, namespace: 'sessionMailbox', method, args })
      await expect(call(h.owner.peer, 'identity', {})).rejects.toThrow()
      const identity = await call(browser, 'identity', {})
      const route = { action: 'send', source: A, target: B }
      await expect(call(h.owner.peer, 'grant', { route, identity })).rejects.toThrow()
      const guest = scoped(h.ctx, { kind: 'mailbox-test-guest' }).peer
      await expect(call(guest, 'grant', { route, identity })).rejects.toThrow()
      await expect(call(browser, 'grant', { route, identity, principal: { kind: 'owner' } })).rejects.toThrow()
      await expect(call(browser, 'grant', { route, identity: { realm: 'other-host', owner: 'single-owner' } })).rejects.toThrow()
      const grant = await call(browser, 'grant', { route, identity }) as { handle: string }
      const prepare = { grant: grant.handle, operation: { action: 'send', requestId: 'gateway-1', text: 'no Agent execution' } }
      await expect(call(h.owner.peer, 'prepare', prepare)).rejects.toThrow()
      const selected = await call(browser, 'prepare', prepare) as { handle: string }
      const sent = await call(browser, 'execute', { selection: selected.handle })
      expect(sent).toMatchObject({ source: A, target: B, mode: 'queue-only', text: 'no Agent execution' })
      expect(sent).not.toHaveProperty('principalKey')
      for (const [requestId, text] of [['blank', '   '], ['escaped', ('a\n').repeat(8192)]]) {
        const pending = await call(browser, 'prepare', { grant: grant.handle, operation: { action: 'send', requestId, text } }) as { handle: string }
        await expect(call(browser, 'execute', { selection: pending.handle })).resolves.toEqual({ outcome: 'not-accepted' })
        // Same identity can safely be repaired only after the authoritative absent-record result.
        const repaired = await call(browser, 'prepare', { grant: grant.handle, operation: { action: 'send', requestId, text: 'repaired' } }) as { handle: string }
        await expect(call(browser, 'execute', { selection: repaired.handle })).resolves.toMatchObject({ text: 'repaired' })
      }
      await expect(call(browser, 'execute', { selection: selected.handle })).rejects.toThrow()
      await expect(call(browser, 'grant', { identity, route: { action: 'trigger-turn', source: A, target: B } })).rejects.toThrow()
      await call(browser, 'revoke', { grant: grant.handle })
      await expect(call(browser, 'prepare', prepare)).rejects.toThrow()
    } finally { await controller.dispose() }
  })
})

it.skipIf(!existsSync(artifact))('mounts the profile plugin with a private fixture root and releases grants and storage ownership on unload', async () => {
  const h = await harness()
  provideBrowserCredentials(h.ctx)
  await h.ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await h.ctx.plugin(Gateway)
  h.ctx.typert.register(await generatedContract())
  const plugin = h.ctx.plugin(mailboxPlugin, h.config)
  await plugin.await()
  const browser = h.ctx.connection.browserPeer
  const invoke = (method: string, args: Record<string, unknown>) => h.ctx.typertGateway.invoke({ peer: browser, namespace: 'sessionMailbox', method, args })
  const identity = await invoke('identity', {})
  const grant = await invoke('grant', { identity, route: { action: 'inbox', target: B } }) as { handle: string }
  const selection = await invoke('prepare', { grant: grant.handle, operation: { action: 'inbox' } }) as { handle: string }
  await plugin.dispose()
  await expect(invoke('execute', { selection: selection.handle })).rejects.toThrow()
  // A fresh lifetime must reacquire the real PID lock, not reuse an in-memory open adapter.
  await withHostMailbox(h.ctx, h.config, async () => {})
})

it('keeps two profile Hosts under one synthetic home independently owned and stable', async () => {
  const web = await harness()
  const desktop = await harness()
  const home = join(web.config.privateRoot, '..')
  vi.stubEnv('DSH_HOME', home)
  const webConfig = { ...web.config, privateRoot: join(home, 'profiles', 'web', 'session-mailbox') }
  const desktopConfig = { ...desktop.config, privateRoot: join(home, 'profiles', 'desktop', 'session-mailbox') }
  let firstRealm = ''
  await withHostMailbox(web.ctx, webConfig, async (first) => {
    firstRealm = first.realm
    await withHostMailbox(desktop.ctx, desktopConfig, async (second) => {
      expect(second.realm).not.toBe(first.realm)
      // Separate profiles may coexist; a duplicate owner of one profile remains refused.
      await expect(withHostMailbox(desktop.ctx, webConfig, async () => {})).rejects.toThrow()
    })
  })
  await withHostMailbox(web.ctx, webConfig, async (reopened) => { expect(reopened.realm).toBe(firstRealm) })
})
