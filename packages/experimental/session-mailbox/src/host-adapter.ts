/** Internal Host adapter: explicit queue-only selection, read-only lifecycle probes, private-root ownership. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { MailboxError, SessionMailbox, type MailboxActor, type MailboxPrincipalKey, type MailboxRecord } from './index.ts'
import { HostMailboxSelections, type MailboxOperationLease } from './host-selection.ts'

const OWNED_STORAGE = Symbol('owned-mailbox-storage')
const identitySpec = defineDomain({
  name: 'session_mailbox_identity', version: 1,
  tables: { owners: domainTable<'owner', { realm: string }>(z.object({ realm: z.uuid() })) },
})

/** Host construction settings, never accepted as Remote method parameters. */
export interface HostMailboxConfig {
  /** Fixed private directory chosen by Host assembly; shared hosts/PID namespaces are unsupported. */
  readonly privateRoot: string
  /** Maximum lock acquisition wait; no takeover of a live or unproven owner. */
  readonly lockWaitMs: number
  /** Retained message limit, including terminal receipts. */
  readonly maxRecords: number
  /** Complete UTF-8 record bound. */
  readonly maxRecordBytes: number
  /** Explicit selection lifetime in milliseconds, from 1 through 30,000. */
  readonly selectionTtlMs: number
}

/** A mutation was accepted, but current authority no longer permits exposing its result. */
export class MailboxOutcomeUnavailableError extends Error {
  /** The operation must be reconciled through a fresh authorized selection, not retried as a new request. */
  readonly code = 'outcome-unavailable'
  constructor() {
    super('Mailbox operation may have committed; select it again with the same operation identity (send requestId or acknowledgement receipt id) to reconcile. No result content is available.')
    this.name = 'MailboxOutcomeUnavailableError'
  }
}

/** Internal adapter, deliberately not a Remote namespace, tool, or Agent input provider. */
export class HostMailboxAdapter {
  /** Issuer reserved for trusted user-selection handlers, not model callers. */
  readonly selections: HostMailboxSelections
  private readonly calls = new WeakMap<object, { ctx: Context; selected: MailboxOperationLease; actor: MailboxActor }>()
  private readonly actorCalls = new WeakMap<MailboxActor, { ctx: Context; selected: MailboxOperationLease }>()
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  private mailbox!: SessionMailbox

  private constructor(private readonly host: Context, selectionTtlMs: number, readonly realm: string) {
    this.selections = new HostMailboxSelections(selectionTtlMs)
  }

  /** Open within an already-owned private storage lifetime.
   * @param host - trusted Host services used for lifecycle and current permissions.
   * @param facility - exclusively owned mailbox domain facility.
   * @param config - fixed Host limits.
   * @param ownership - private construction token held only inside the storage lifetime helper.
   * @returns internal adapter; callers must drain close before releasing storage ownership.
   */
  static async open(
    host: Context, facility: DomainFacility, config: HostMailboxConfig, ownership: typeof OWNED_STORAGE,
  ): Promise<HostMailboxAdapter> {
    if (ownership !== OWNED_STORAGE) throw new MailboxError('denied')
    const identity = await facility.open(identitySpec)
    let realm: string
    try {
      const owners = identity.table('owners')
      const existing = owners.get('owner')
      if (owners.size > 1 || owners.size !== 0 && !existing) throw new MailboxError('invalid')
      realm = existing?.realm ?? randomUUID()
      if (!existing) await owners.put('owner', { realm })
    } finally { await identity.close() }
    const adapter = new HostMailboxAdapter(host, config.selectionTtlMs, realm)
    adapter.mailbox = await SessionMailbox.open(facility, {
      maxRecords: config.maxRecords, maxRecordBytes: config.maxRecordBytes,
      resolve: token => adapter.calls.get(token)?.actor,
      allows: (actor, action, source, target) => {
        const call = adapter.actorCalls.get(actor)
        if (!call) return false
        try { call.selected.check(call.ctx) } catch (error) {
          if (error instanceof MailboxError) return false
          throw error
        }
        const selection = call.selected.selection
        if (selection.action !== action) return false
        if (selection.target !== target || selection.action === 'send' && selection.source !== source) return false
        return adapter.allowed(call.ctx, action, source, target)
      },
      canReceive: target => !host.workspaceRegistry.archivedSessionIds.includes(target),
    })
    return adapter
  }

  /** Execute an exact Host-issued selection without restoring or running an Agent.
   * @param ctx - current trusted Host invocation context.
   * @param token - opaque user-selection capability issued by this adapter.
   * @returns durable receipt, or authorized inbox records; never a model answer.
   */
  execute(ctx: Context, token: object): Promise<MailboxRecord | readonly MailboxRecord[]> {
    if (this.closing) return Promise.reject(new MailboxError('closed'))
    const result = this.chain.then(async () => {
      const selected = this.selections.claim(ctx, token)
      let actor: MailboxActor | undefined
      let acceptedMutation = false
      try {
        const selection = selected.selection
        if (!this.allowed(ctx, selection.action, selection.action === 'send' ? selection.source : selection.target, selection.target)) {
          throw new MailboxError('denied')
        }
        await this.requireSession(selection.target, selected.signal)
        selected.check(ctx)
        if (selection.action === 'send') await this.requireSession(selection.source, selected.signal)
        selected.check(ctx)
        actor = {
          principal: selected.peer.principal,
          principalKey: brandString<MailboxPrincipalKey>('owner'),
          sessionId: selection.action === 'send' ? selection.source : selection.target,
        }
        this.calls.set(token, { ctx, selected, actor })
        this.actorCalls.set(actor, { ctx, selected })
        let value: MailboxRecord | readonly MailboxRecord[]
        if (selection.action === 'send') {
          value = await this.mailbox.send(token, selection, selected.signal)
          acceptedMutation = true
        } else if (selection.action === 'ack') {
          value = await this.mailbox.settle(token, selection.id, 'ack')
          acceptedMutation = true
        } else {
          value = this.mailbox.list(token, 'inbox')
        }
        // Admission does not retract a durable write. A revoked/archived recipient sees no response body.
        selected.check(ctx)
        await this.requireSession(selection.target, selected.signal)
        selected.check(ctx)
        if (!this.allowed(ctx, selection.action, selection.action === 'send' ? selection.source : selection.target, selection.target)) {
          throw new MailboxError('denied')
        }
        const records = 'id' in value ? [value] : value
        for (const record of records) {
          if (!this.allowed(ctx, selection.action, record.source, record.target)) throw new MailboxError('denied')
        }
        selected.check(ctx)
        return value
      } catch (error) {
        // Do not expose message content or imply that a committed write was rolled back.
        if (acceptedMutation) throw new MailboxOutcomeUnavailableError()
        selected.check(ctx)
        throw error
      } finally {
        this.calls.delete(token)
        if (actor) this.actorCalls.delete(actor)
        selected.dispose()
      }
    })
    this.chain = result.then(() => {}, () => {})
    return result
  }

  /** Reject new calls and drain accepted operations before releasing the domain.
   * @returns resolution after storage writes stop.
   */
  async close(): Promise<void> {
    this.closing = true
    await this.chain
    await this.mailbox.close()
  }

  private allowed(ctx: Context, action: string, source: SessionId, target: SessionId): boolean {
    const invocation = ctx.invocation
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- principal kinds are merge-extensible across Host assemblies.
    if (!invocation || invocation.peer.principal.kind !== 'owner' || invocation.peer.signal.aborted
      || invocation.signal.aborted || this.host.workspaceRegistry.archivedSessionIds.includes(target)
      || action === 'send' && this.host.workspaceRegistry.archivedSessionIds.includes(source)) return false
    // RemoteAccess deliberately allows owner. Explicit selection remains a separate mandatory check.
    return this.host.remoteAccess.decide({
      principal: invocation.peer.principal, action: `sessionMailbox/${action}`,
      resources: [{ kind: 'session', id: source }, { kind: 'session', id: target }],
    }).kind === 'allow'
  }

  private async requireSession(id: SessionId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const live = this.host.sessions.get(id)
    const snapshot = live ? undefined : await this.host.sessionPersistence.stat(id, { signal })
    const header = live?.header ?? snapshot?.header
    if (!header || header.origin === 'subagent' || snapshot?.formatStatus === 'migration-required'
      || this.host.workspaceRegistry.archivedSessionIds.includes(id)) throw new MailboxError('denied')
  }
}

/** Hold cooperative single-Host storage ownership across the complete adapter lifetime.
 * @param host - trusted assembly with Session, Workspace and RemoteAccess services.
 * @param config - fixed Host private path and explicit limits, never a user-selected path.
 * @param operation - internal Host lifetime; no public route is installed by this helper.
 * @returns the operation result after the adapter and backend have drained and the lock released.
 */
export async function withHostMailbox<T>(
  host: Context, config: HostMailboxConfig, operation: (adapter: HostMailboxAdapter) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(config.privateRoot) || !Number.isSafeInteger(config.lockWaitMs) || config.lockWaitMs < 0) {
    throw new MailboxError('invalid')
  }
  await mkdir(config.privateRoot, { recursive: true, mode: 0o700 })
  const metadata = await lstat(config.privateRoot)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || process.platform !== 'win32' && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.())) throw new MailboxError('denied')
  const root = await realpath(config.privateRoot)
  return withFileLock(join(root, 'session_mailbox.json'), async () => {
    const storage = new Context()
    await storage.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    storage.effect(() => storage.storage.backend.register('session-mailbox', backend), 'session-mailbox.backend')
    const facility = new DomainFacility(storage, { backend: 'session-mailbox' })
    let adapter: HostMailboxAdapter | undefined
    try {
      adapter = await HostMailboxAdapter.open(host, facility, config, OWNED_STORAGE)
      return await operation(adapter)
    } finally {
      try { await adapter?.close() } finally {
        try { await backend.close() } finally { await storage.fiber.dispose() }
      }
    }
  }, { waitMs: config.lockWaitMs })
}
