import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionMailbox, type MailboxActor, type MailboxPolicy, type MailboxPrincipalKey } from '../src/index.ts'

const roots: string[] = []
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const A = brandString<SessionId>('session-a')
const B = brandString<SessionId>('session-b')
const C = brandString<SessionId>('session-c')
const signal = new AbortController().signal
async function harness(existingRoot?: string, overrides: Partial<MailboxPolicy> = {}) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-mailbox-'))
  if (!existingRoot) roots.push(root)
  const ctx = new Context()
  const storageFiber = ctx.plugin(Storage)
  await storageFiber
  const backend = new JsonStorageBackend(root)
  const faults: { afterWrite: boolean; beforeWrite?: () => Promise<void> } = { afterWrite: false }
  const openUnit = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await openUnit(descriptor)
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      await faults.beforeWrite?.()
      await put(table, key, value)
      if (faults.afterWrite) throw new Error('simulated post-publish acknowledgement loss')
    }
    return unit
  }
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const sender = Object.freeze({})
  const recipient = Object.freeze({})
  const stranger = Object.freeze({})
  const identities = new Map<object, MailboxActor>([
    [sender, { principal: { kind: 'owner' }, principalKey: brandString<MailboxPrincipalKey>('owner'), sessionId: A }],
    [recipient, { principal: { kind: 'owner' }, principalKey: brandString<MailboxPrincipalKey>('owner'), sessionId: B }],
    [stranger, { principal: { kind: 'owner' }, principalKey: brandString<MailboxPrincipalKey>('owner'), sessionId: C }],
  ])
  const policy: MailboxPolicy = {
    maxRecords: 10, maxRecordBytes: 2048,
    resolve: caller => identities.get(caller), allows: () => true,
    canReceive: target => target === A || target === B, ...overrides,
  }
  disposals.push(async () => { await backend.close(); await storageFiber.dispose() })
  const mailbox = await SessionMailbox.open(facility, policy)
  const close = async () => { await mailbox.close(); await backend.close(); await storageFiber.dispose() }
  disposals.push(close)
  return { root, mailbox, sender, recipient, stranger, identities, policy, close, facility, faults }
}
const request = { target: B, requestId: 'retry-1', text: 'Untrusted result only' }

describe('queue-only mailbox on real JSON storage', () => {
  it('persists one record for concurrent retries and reconstructs both views after a Host restart', async () => {
    const first = await harness()
    const records = await Promise.all(Array.from({ length: 12 }, () => first.mailbox.send(first.sender, request, signal)))
    expect(new Set(records.map(record => record.id)).size).toBe(1)
    expect(first.mailbox.list(first.recipient, 'inbox')).toHaveLength(1)
    expect(first.mailbox.list(first.sender, 'outbox')).toEqual([records[0]])
    await first.close()
    const restarted = await harness(first.root)
    expect(restarted.mailbox.list(restarted.recipient, 'inbox')).toEqual([records[0]])
    expect(await restarted.mailbox.send(restarted.sender, request, signal)).toEqual(records[0])
    expect(records[0]).toMatchObject({ trust: 'untrusted-agent-content', mode: 'queue-only', status: 'queued' })
  })
  it('publishes only after durable commit and pins admitted identity despite revocation during the write', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.faults.beforeWrite = async () => { entered.resolve(undefined); await release.promise }
    const actor = h.identities.get(h.sender)!
    const mutableRequest = { ...request }
    const pending = h.mailbox.send(h.sender, mutableRequest, signal)
    await entered.promise
    expect(h.mailbox.list(h.recipient, 'inbox')).toEqual([])
    expect(h.mailbox.list(h.sender, 'outbox')).toEqual([])
    Object.assign(actor, { sessionId: C, principalKey: brandString<MailboxPrincipalKey>('changed') })
    Object.assign(mutableRequest, { target: C, text: 'Changed while writing' })
    h.policy.allows = () => false
    release.resolve(undefined)
    const receipt = await pending
    expect(receipt).toMatchObject({ source: A, target: B, principalKey: 'owner', text: request.text })
    expect(h.mailbox.list(h.recipient, 'inbox')).toEqual([])
    await expect(h.mailbox.send(h.sender, request, signal)).rejects.toMatchObject({ code: 'denied' })
    await expect(h.mailbox.settle(h.recipient, receipt.id, 'ack')).rejects.toMatchObject({ code: 'denied' })
    h.policy.allows = () => true
    expect(h.mailbox.list(h.recipient, 'inbox')).toEqual([receipt])
    h.policy.canReceive = () => false
    Object.assign(actor, { sessionId: A, principalKey: brandString<MailboxPrincipalKey>('owner') })
    await expect(h.mailbox.send(h.sender, request, signal)).rejects.toMatchObject({ code: 'denied' })
  })
  it('does not undo an admitted acknowledgement when permissions change during its write', async () => {
    const h = await harness()
    const receipt = await h.mailbox.send(h.sender, request, signal)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.faults.beforeWrite = async () => { entered.resolve(undefined); await release.promise }
    const pending = h.mailbox.settle(h.recipient, receipt.id, 'ack')
    await entered.promise
    expect(h.mailbox.list(h.sender, 'outbox')[0]?.status).toBe('queued')
    h.policy.allows = () => false
    release.resolve(undefined)
    expect(await pending).toMatchObject({ id: receipt.id, status: 'acknowledged' })
    await expect(h.mailbox.settle(h.recipient, receipt.id, 'ack')).rejects.toMatchObject({ code: 'denied' })
    h.policy.allows = () => true
    expect(h.mailbox.list(h.sender, 'outbox')[0]?.status).toBe('acknowledged')
  })
  it('binds retry identity to sender and principal and rejects changed content or destination', async () => {
    const h = await harness()
    await h.mailbox.send(h.sender, request, signal)
    await expect(h.mailbox.send(h.sender, { ...request, text: 'Changed' }, signal)).rejects.toMatchObject({ code: 'conflict' })
    h.policy.canReceive = () => true
    await expect(h.mailbox.send(h.sender, { ...request, target: C }, signal)).rejects.toMatchObject({ code: 'conflict' })
    const reverse = await h.mailbox.send(h.recipient, { ...request, target: A }, signal)
    expect(h.mailbox.list(h.recipient, 'outbox')).toEqual([reverse])
    h.identities.set(h.sender, { principal: { kind: 'owner' }, principalKey: brandString<MailboxPrincipalKey>('different-principal'), sessionId: A })
    expect(h.mailbox.list(h.sender, 'outbox')).toEqual([])
    const other = await h.mailbox.send(h.sender, request, signal)
    expect(other.id).not.toBe(reverse.id)
    expect(h.mailbox.list(h.recipient, 'inbox')).toHaveLength(2)
  })
  it('refuses forged caller, self delivery, unavailable targets and current permission revocation', async () => {
    const h = await harness()
    await expect(h.mailbox.send({}, request, signal)).rejects.toMatchObject({ code: 'denied' })
    await expect(h.mailbox.send(h.sender, { ...request, target: A }, signal)).rejects.toMatchObject({ code: 'denied' })
    await expect(h.mailbox.send(h.sender, { ...request, target: C }, signal)).rejects.toMatchObject({ code: 'denied' })
    await h.mailbox.send(h.sender, request, signal)
    h.policy.allows = () => false
    expect(h.mailbox.list(h.recipient, 'inbox')).toEqual([])
    await expect(h.mailbox.send(h.sender, request, signal)).rejects.toMatchObject({ code: 'denied' })
  })
  it('serializes cancel versus acknowledgement, retains terminal dedupe and denies wrong participants', async () => {
    const h = await harness()
    const record = await h.mailbox.send(h.sender, request, signal)
    await expect(h.mailbox.settle(h.stranger, record.id, 'ack')).rejects.toMatchObject({ code: 'denied' })
    await expect(h.mailbox.settle(h.recipient, record.id, 'cancel')).rejects.toMatchObject({ code: 'denied' })
    const results = await Promise.allSettled([h.mailbox.settle(h.sender, record.id, 'cancel'), h.mailbox.settle(h.recipient, record.id, 'ack')])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await h.mailbox.send(h.sender, request, signal)).toMatchObject({ id: record.id, status: 'cancelled' })
    expect(await h.mailbox.settle(h.sender, record.id, 'cancel')).toMatchObject({ status: 'cancelled' })
    await h.close()
    const restarted = await harness(h.root)
    expect(await restarted.mailbox.send(restarted.sender, request, signal)).toMatchObject({ status: 'cancelled' })
  })
  it('acknowledges without consuming a model turn and isolates returned snapshots', async () => {
    const h = await harness()
    const record = await h.mailbox.send(h.sender, request, signal)
    const settled = await h.mailbox.settle(h.recipient, record.id, 'ack')
    expect(settled.status).toBe('acknowledged')
    Object.assign(settled, { text: 'mutated externally' })
    expect(h.mailbox.list(h.sender, 'outbox')[0]?.text).toBe(request.text)
    await expect(h.mailbox.settle(h.sender, record.id, 'cancel')).rejects.toMatchObject({ code: 'not-queued' })
  })
  it('bounds complete UTF-8 records and retained tombstones, and cancels before admission', async () => {
    const h = await harness(undefined, { maxRecords: 1, maxRecordBytes: 400 })
    await expect(h.mailbox.send(h.sender, { ...request, text: '字'.repeat(100) }, signal)).rejects.toMatchObject({ code: 'limit' })
    const aborted = new AbortController(); aborted.abort()
    await expect(h.mailbox.send(h.sender, request, aborted.signal)).rejects.toThrow()
    expect(h.mailbox.list(h.sender, 'outbox')).toEqual([])
    const record = await h.mailbox.send(h.sender, request, signal)
    await h.mailbox.settle(h.sender, record.id, 'cancel')
    await expect(h.mailbox.send(h.sender, { ...request, requestId: 'second' }, signal)).rejects.toMatchObject({ code: 'limit' })
    await h.close()
    await expect(h.mailbox.send(h.sender, request, signal)).rejects.toMatchObject({ code: 'closed' })
  })
  it('rejects a second owner in the same facility rather than opening another write chain', async () => {
    const h = await harness()
    await expect(SessionMailbox.open(h.facility, h.policy)).rejects.toMatchObject({ code: 'already-open' })
  })
  it('quarantines an uncertain post-publish result and recovers the same receipt after reopen', async () => {
    const h = await harness()
    h.faults.afterWrite = true
    await expect(h.mailbox.send(h.sender, request, signal)).rejects.toMatchObject({ code: 'unknown-state' })
    expect(() => h.mailbox.list(h.recipient, 'inbox')).toThrow(/unknown-state/)
    await expect(h.mailbox.send(h.sender, { ...request, requestId: 'other' }, signal)).rejects.toMatchObject({ code: 'unknown-state' })
    await h.close()
    const reopened = await harness(h.root)
    const receipt = await reopened.mailbox.send(reopened.sender, request, signal)
    expect(reopened.mailbox.list(reopened.recipient, 'inbox')).toEqual([receipt])
  })
  it('ignores an interrupted unpublished temporary file and retains the last committed receipt', async () => {
    const h = await harness()
    const receipt = await h.mailbox.send(h.sender, request, signal)
    await h.close()
    await writeFile(join(h.root, '.interrupted.tmp'), '{partial')
    const reopened = await harness(h.root)
    expect(reopened.mailbox.list(reopened.recipient, 'inbox')).toEqual([receipt])
  })
  it('fails closed on truncated authoritative media instead of treating lost receipts as empty', async () => {
    const h = await harness()
    await h.mailbox.send(h.sender, request, signal)
    await h.close()
    const path = join(h.root, 'session_mailbox.json')
    const bytes = await readFile(path, 'utf8')
    await writeFile(path, bytes.slice(0, bytes.length / 2))
    await expect(harness(h.root)).rejects.toThrow()
  })
})
