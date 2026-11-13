/** Per-tab retry identity storage. Only user-entered drafts, never capabilities, are retained. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { MailboxIdentity } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Browser retry-state failures are distinct from an unknown network mutation outcome. */
export class MailboxDraftError extends Error {}
function access<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof MailboxDraftError) throw error
    throw new MailboxDraftError('Mailbox retry state is unavailable')
  }
}

/** An unresolved send retains exactly the identity and body required by durable deduplication. */
export interface MailboxDraft {
  readonly source: SessionId
  readonly target: SessionId
  readonly requestId: string
  readonly text: string
}
/** Retains send content and identity until the Host gives a definite result. */
export interface MailboxDraftStore {
  read(source: SessionId): MailboxDraft | undefined
  save(source: SessionId, target: SessionId, text: string): MailboxDraft
  complete(source: SessionId, requestId: string): void
}

/** A readable partition key excludes URL credentials, query tokens and fragments. */
/**
 * Scope retry state to the current Host and mailbox.
 * @param page - current Client page URL.
 * @param identity - Host mailbox identity.
 * @returns the storage key suffix without credentials.
 */
export function draftPartition(page: string, identity: MailboxIdentity): string {
  const base = new URL('.', page)
  return JSON.stringify({ endpoint: base.origin + base.pathname, realm: identity.realm, owner: identity.owner })
}

/**
 * Store pending sends within the browser tab.
 * @param storage - tab-local storage access.
 * @param hostBase - partition from the current Host identity.
 * @returns the pending send store.
 */
export function sessionDraftStore(storage: Pick<Storage, 'getItem' | 'setItem'>, hostBase: string): MailboxDraftStore {
  const key = `dsh.session-mailbox.pending:${hostBase}`
  const readAll = (): MailboxDraft[] => {
    const raw = access(() => storage.getItem(key))
    if (raw === null) return []
    if (raw.length > 1_100_000) throw new MailboxDraftError('Mailbox retry state is unavailable')
    const parsed: unknown = access(() => JSON.parse(raw))
    if (!Array.isArray(parsed) || parsed.length > 32) throw new MailboxDraftError('Mailbox retry state is unavailable')
    const values: readonly unknown[] = parsed
    const rows: MailboxDraft[] = []
    for (const value of values) {
      if (!value || typeof value !== 'object') throw new MailboxDraftError('Mailbox retry state is unavailable')
      const row = value as Record<string, unknown>
      if (typeof row.source !== 'string' || !row.source || row.source.length > 256
        || typeof row.target !== 'string' || !row.target || row.target.length > 256
        || typeof row.requestId !== 'string' || !row.requestId || row.requestId.length > 256
        || typeof row.text !== 'string' || new TextEncoder().encode(row.text).length > 16_384) {
        throw new MailboxDraftError('Mailbox retry state is unavailable')
      }
      if (rows.some(prior => prior.source === row.source)) throw new MailboxDraftError('Mailbox retry state is unavailable')
      rows.push({ source: row.source as SessionId, target: row.target as SessionId, requestId: row.requestId, text: row.text })
    }
    return rows
  }
  return {
    read: source => readAll().find(row => row.source === source),
    save(source, target, text) {
      const rows = readAll()
      const prior = rows.find(row => row.source === source)
      if (prior?.target === target && prior.text === text) return prior
      // An unknown previous send must be reconciled, not silently replaced with another identity.
      if (prior) throw new MailboxDraftError('Reconcile the pending mailbox draft before changing it')
      if (!text.trim() || new TextEncoder().encode(text).length > 16_384) throw new MailboxDraftError('Mailbox draft is empty or too large')
      if (rows.length >= 32) throw new MailboxDraftError('Mailbox retry state is full')
      const draft: MailboxDraft = { source, target, requestId: randomUUID(), text }
      access(() => { storage.setItem(key, JSON.stringify([...rows, draft])) })
      return draft
    },
    complete(source, requestId) {
      const rows = readAll()
      access(() => { storage.setItem(key, JSON.stringify(rows.filter(row => row.source !== source || row.requestId !== requestId))) })
    },
  }
}
