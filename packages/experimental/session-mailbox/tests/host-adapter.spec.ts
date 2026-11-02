import { mkdtemp, rm, chmod, readFile } from 'node:fs/promises'
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
import { withHostMailbox, type HostMailboxConfig } from '../src/host-adapter.ts'
import type { MailboxRecord } from '../src/index.ts'
import { HostMailboxSelections } from '../src/host-selection.ts'

const publishGate = vi.hoisted(() => ({ afterRename: undefined as ((to: string) => void) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]): Promise<void> => {
      await actual.rename(from, to)
      publishGate.afterRename?.(String(to))
    },
  }
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'mailbox-test-guest': { readonly kind: 'mailbox-test-guest' }
  }
}
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  publishGate.afterRename = undefined
  vi.restoreAllMocks()
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
  const root = await mkdtemp(join(tmpdir(), 'mailbox-host-'))
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

describe('internal Host mailbox adapter', () => {
  it('uses real Host services and JSON persistence without Agent activation or Session event injection', async () => {
    const h = await harness()
    const decides = vi.spyOn(h.ctx.remoteAccess, 'decide')
    const events = vi.fn()
    h.ctx.on('session/event', events)
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const selected = { action: 'send' as const, source: A, target: B, requestId: 'selected-1', text: 'Untrusted result' }
      const token = adapter.selections.issue(h.owner.ctx, selected, h.selection.signal)
      Object.assign(selected, { target: C, text: 'mutated caller input' })
      const sent = receipt(await adapter.execute(h.owner.ctx, token))
      expect(sent).toMatchObject({ source: A, target: B, text: 'Untrusted result', mode: 'queue-only' })
      const inbox = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      expect(await adapter.execute(h.owner.ctx, inbox)).toEqual([sent])
      const ack = adapter.selections.issue(h.owner.ctx, { action: 'ack', target: B, id: sent.id }, h.selection.signal)
      expect(await adapter.execute(h.owner.ctx, ack)).toMatchObject({ status: 'acknowledged' })
      expect(events).not.toHaveBeenCalled()
      expect(h.ctx.get('agents')).toBeUndefined()
      expect(decides).toHaveBeenCalledWith(expect.objectContaining({ action: 'sessionMailbox/send', resources: [{ kind: 'session', id: A }, { kind: 'session', id: B }] }))
    })
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const token = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      expect(await adapter.execute(h.owner.ctx, token)).toMatchObject([{ status: 'acknowledged' }])
    })
  })
  it('rejects forged tokens, missing invocation, a different owner Peer and disposed peers', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const issue = () => adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      await expect(adapter.execute(h.owner.ctx, { principal: { kind: 'owner' } })).rejects.toMatchObject({ code: 'denied' })
      await expect(adapter.execute(h.ctx, issue())).rejects.toMatchObject({ code: 'denied' })
      await expect(adapter.execute(scoped(h.ctx).ctx, issue())).rejects.toMatchObject({ code: 'denied' })
      const beforeDispose = issue()
      await h.owner.peer.dispose()
      await expect(adapter.execute(h.owner.ctx, beforeDispose)).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it('keeps owner default-allow separate from explicit selection and denies guests through real RemoteAccess', async () => {
    const h = await harness()
    const guest = scoped(h.ctx, { kind: 'mailbox-test-guest' })
    const resources = [{ kind: 'session' as const, id: B }]
    expect(h.ctx.remoteAccess.decide({ principal: guest.peer.principal, action: 'sessionMailbox/inbox', resources })).toMatchObject({ kind: 'deny' })
    expect(h.ctx.remoteAccess.decide({ principal: h.owner.peer.principal, action: 'sessionMailbox/inbox', resources })).toMatchObject({ kind: 'allow' })
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      expect(() => adapter.selections.issue(guest.ctx, { action: 'inbox', target: B }, h.selection.signal)).toThrow(/denied/)
      await expect(adapter.execute(h.owner.ctx, {})).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it('accepts cold ordinary Sessions without open/create and refuses unknown, archived and child targets', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const send = (target: SessionId, requestId: string) => adapter.execute(h.owner.ctx,
        adapter.selections.issue(h.owner.ctx, { action: 'send', source: A, target, requestId, text: 'result' }, h.selection.signal))
      expect(await send(C, 'cold')).toMatchObject({ target: C, mode: 'queue-only' })
      await expect(send(SessionId('missing'), 'missing')).rejects.toMatchObject({ code: 'denied' })
      await h.ctx.workspaceRegistry.archiveSession(B)
      await expect(send(B, 'archived')).rejects.toMatchObject({ code: 'denied' })
      const child = SessionId('child')
      h.persistence.records.set(child, { id: child, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: A })
      await expect(send(child, 'child')).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it('accepts a target reported as running without stopping or steering its work', async () => {
    const h = await harness()
    const stopped = vi.fn()
    h.ctx.on('workspace/session-stop', stopped)
    h.ctx.on('workspace/session-activity', async (request, next) => {
      const rest = await next()
      return request.sessionId === B ? [{ kind: 'turn' as const }, ...rest] : rest
    })
    await expect(h.ctx.workspaceRegistry.archiveSession(B)).rejects.toThrow(/active/)
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const token = adapter.selections.issue(h.owner.ctx, { action: 'send', source: A, target: B, requestId: 'running', text: 'result' }, h.selection.signal)
      expect(await adapter.execute(h.owner.ctx, token)).toMatchObject({ status: 'queued', mode: 'queue-only' })
    })
    expect(stopped).not.toHaveBeenCalled()
    expect(h.ctx.get('agents')).toBeUndefined()
  })
  it('rechecks archive and deletion after a delayed lifecycle probe and hides old inbox content', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const token = adapter.selections.issue(h.owner.ctx, { action: 'send', source: A, target: C, requestId: 'cold', text: 'result' }, h.selection.signal)
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      h.persistence.beforeStat = async () => { entered.resolve(undefined); await release.promise }
      const pending = adapter.execute(h.owner.ctx, token)
      await entered.promise
      h.persistence.records.delete(C)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'denied' })
      h.persistence.beforeStat = undefined
      const inbox = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: C }, h.selection.signal)
      await expect(adapter.execute(h.owner.ctx, inbox)).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it('refuses archive that completes while a cold-target probe is waiting', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let first = true
    h.persistence.beforeStat = async () => {
      if (first) { first = false; entered.resolve(undefined); await release.promise }
    }
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const selected = adapter.selections.issue(h.owner.ctx, { action: 'send', source: A, target: C, requestId: 'archive-race', text: 'result' }, h.selection.signal)
      const pending = adapter.execute(h.owner.ctx, selected)
      await entered.promise
      await h.ctx.workspaceRegistry.archiveSession(C)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it('keeps queued messages hidden while archived and permits explicit read after unarchive', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const sent = receipt(await adapter.execute(h.owner.ctx, adapter.selections.issue(h.owner.ctx,
        { action: 'send', source: A, target: B, requestId: 'before-archive', text: 'result' }, h.selection.signal)))
      await h.ctx.workspaceRegistry.archiveSession(B)
      const inbox = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      await expect(adapter.execute(h.owner.ctx, inbox)).rejects.toMatchObject({ code: 'denied' })
      await h.ctx.workspaceRegistry.unarchiveSession(B)
      expect(await adapter.execute(h.owner.ctx, adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal))).toEqual([sent])
    })
  })
  it('hides the response if target deletion happens after commit without undoing the durable receipt', async () => {
    const h = await harness()
    let probes = 0
    h.persistence.beforeStat = async () => { if (++probes === 2) h.persistence.records.delete(C) }
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const token = adapter.selections.issue(h.owner.ctx, { action: 'send', source: A, target: C, requestId: 'committed', text: 'result' }, h.selection.signal)
      await expect(adapter.execute(h.owner.ctx, token)).rejects.toMatchObject({ code: 'outcome-unavailable' })
    })
    expect(await readFile(join(h.config.privateRoot, 'session_mailbox.json'), 'utf8')).toContain('committed')
  })
  it('consumes a selection once across concurrent and later calls, including future inbox contents', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const token = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      const outcomes = await Promise.allSettled([adapter.execute(h.owner.ctx, token), adapter.execute(h.owner.ctx, token)])
      expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      const send = adapter.selections.issue(h.owner.ctx,
        { action: 'send', source: A, target: B, requestId: 'later', text: 'later content' }, h.selection.signal)
      await adapter.execute(h.owner.ctx, send)
      await expect(adapter.execute(scoped(h.ctx, { kind: 'owner' }, h.owner.peer).ctx, token)).rejects.toMatchObject({ code: 'denied' })
      const fresh = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      expect(await adapter.execute(h.owner.ctx, fresh)).toHaveLength(1)
    })
  })
  it('permits one later invocation on the same Peer without treating issuing RPC completion as selection cancellation', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const token = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      h.owner.signal.abort('issuing RPC completed; selection remains active')
      const later = scoped(h.ctx, { kind: 'owner' }, h.owner.peer)
      expect(await adapter.execute(later.ctx, token)).toEqual([])
      await expect(adapter.execute(later.ctx, token)).rejects.toMatchObject({ code: 'denied' })
      const cancelled = adapter.selections.issue(later.ctx, { action: 'inbox', target: B }, h.selection.signal)
      h.selection.abort('user cancelled selection')
      await expect(adapter.execute(later.ctx, cancelled)).rejects.toMatchObject({ code: 'denied' })
      expect(() => adapter.selections.issue(later.ctx, { action: 'inbox', target: B }, h.selection.signal)).toThrow(/denied/)
      expect(() => adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, new AbortController().signal)).toThrow(/denied/)
    })
  })
  it('checks monotonic TTL before claim, during execution and after lease disposal', async () => {
    const h = await harness()
    let now = 0
    const selections = new HostMailboxSelections(1000, () => now)
    const early = selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
    const expires = selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
    now = 999
    const lease = selections.claim(h.owner.ctx, early)
    expect(() => { lease.check(h.owner.ctx) }).not.toThrow()
    now = 1000
    expect(() => { lease.check(h.owner.ctx) }).toThrow(/denied/)
    expect(() => selections.claim(h.owner.ctx, expires)).toThrow(/denied/)
    expect(() => selections.claim(h.owner.ctx, early)).toThrow(/denied/)
    const fresh = selections.claim(h.owner.ctx, selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal))
    fresh.dispose()
    expect(() => { fresh.check(h.owner.ctx) }).toThrow(/denied/)
    expect(() => new HostMailboxSelections(30_001)).toThrow(/invalid/)
  })
  it('consumes expired selections waiting behind another operation without allowing duplicate queued claims', async () => {
    const h = await harness()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.persistence.beforeStat = async () => { entered.resolve(undefined); await release.promise }
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      const first = adapter.execute(h.owner.ctx, adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: C }, h.selection.signal))
      await entered.promise
      const queued = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      const outcomes = Promise.allSettled([first, adapter.execute(h.owner.ctx, queued), adapter.execute(h.owner.ctx, queued)])
      clock.mockReturnValue(1000)
      release.resolve(undefined)
      expect((await outcomes).map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
      await expect(adapter.execute(h.owner.ctx, queued)).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it.each(['execution', 'selection', 'peer', 'expiry'] as const)(
    'refuses an empty inbox when %s ends during its final lifecycle probe', async (cause) => {
      const h = await harness()
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
      let probes = 0
      h.persistence.beforeStat = async () => {
        if (++probes !== 2) return
        if (cause === 'execution') h.owner.signal.abort()
        else if (cause === 'selection') h.selection.abort()
        else if (cause === 'peer') await h.owner.peer.dispose()
        else clock.mockReturnValue(1000)
      }
      await withHostMailbox(h.ctx, h.config, async (adapter) => {
        const token = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: C }, h.selection.signal)
        await expect(adapter.execute(h.owner.ctx, token)).rejects.toMatchObject({ code: 'denied' })
        expect(probes).toBe(2)
      })
    },
  )
  it.each(['expiry', 'selection cancellation'] as const)('reports an unavailable outcome for %s during a real publish and reconciles a fresh selection', async (cause) => {
    const h = await harness()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const send = { action: 'send' as const, source: A, target: B, requestId: 'expired-publish', text: 'private payload marker' }
    await withHostMailbox(h.ctx, h.config, async (adapter) => {
      publishGate.afterRename = (to) => {
        if (to !== join(h.config.privateRoot, 'session_mailbox.json')) return
        if (cause === 'expiry') clock.mockReturnValue(1000)
        else h.selection.abort('user cancelled while publication was in progress')
      }
      const token = adapter.selections.issue(h.owner.ctx, send, h.selection.signal)
      const outcome = await adapter.execute(h.owner.ctx, token).catch((error: unknown) => error)
      if (!(outcome instanceof Error)) throw new Error('expected an unavailable operation outcome')
      expect(outcome).toMatchObject({ code: 'outcome-unavailable' })
      expect(outcome).not.toHaveProperty('text')
      expect(outcome.message).not.toContain(send.text)
      expect(await readFile(join(h.config.privateRoot, 'session_mailbox.json'), 'utf8')).toContain(send.requestId)
      publishGate.afterRename = undefined
      h.selection = new AbortController()
      await h.ctx.workspaceRegistry.archiveSession(B)
      await expect(adapter.execute(h.owner.ctx, adapter.selections.issue(h.owner.ctx, send, h.selection.signal)))
        .rejects.toMatchObject({ code: 'denied' })
      await h.ctx.workspaceRegistry.unarchiveSession(B)
      const reconciled = receipt(await adapter.execute(h.owner.ctx, adapter.selections.issue(h.owner.ctx, send, h.selection.signal)))
      expect(reconciled).toMatchObject({ requestId: send.requestId, status: 'queued' })
      const inbox = adapter.selections.issue(h.owner.ctx, { action: 'inbox', target: B }, h.selection.signal)
      expect(await adapter.execute(h.owner.ctx, inbox)).toEqual([reconciled])
      await expect(adapter.execute(h.owner.ctx, token)).rejects.toMatchObject({ code: 'denied' })
    })
  })
  it('refuses a second cooperative adapter for the same private root and releases after failure', async () => {
    const h = await harness()
    await expect(withHostMailbox(h.ctx, h.config, async () => {
      await expect(withHostMailbox(h.ctx, h.config, async () => true)).rejects.toThrow(/writer lock/)
      throw new Error('Host lifetime ended')
    })).rejects.toThrow('Host lifetime ended')
    await expect(withHostMailbox(h.ctx, h.config, async () => true)).resolves.toBe(true)
  })
  it.skipIf(process.platform === 'win32')('refuses a non-private POSIX root rather than silently changing its permissions', async () => {
    const h = await harness()
    await withHostMailbox(h.ctx, h.config, async () => undefined)
    await chmod(h.config.privateRoot, 0o755)
    await expect(withHostMailbox(h.ctx, h.config, async () => undefined)).rejects.toMatchObject({ code: 'denied' })
  })
})
