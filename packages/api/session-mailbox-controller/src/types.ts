/** Browser-authorized mailbox routes and one-operation handles; none is an Agent instruction. */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Exact route explicitly authorized by the owner browser. */
export type MailboxRoute =
  | { readonly action: 'send'; readonly source: SessionId; readonly target: SessionId }
  | { readonly action: 'inbox' | 'ack'; readonly target: SessionId }

/** Operation body bound to an existing route; the route cannot be replaced in prepare. */
export type MailboxOperation =
  | { readonly action: 'send'; readonly requestId: string; readonly text: string }
  | { readonly action: 'inbox' }
  | { readonly action: 'ack'; readonly id: string }

/** Opaque wire reference, useful only on its issuing Host's authenticated browser Peer. */
export interface MailboxHandle { readonly handle: string }

/** Public message view; storage principal keys and capabilities never leave the Host. */
export interface MailboxMessage {
  readonly id: string
  readonly source: SessionId
  readonly target: SessionId
  readonly text: string
  readonly status: 'queued' | 'acknowledged' | 'cancelled'
  readonly trust: 'untrusted-agent-content'
  readonly mode: 'queue-only'
}

/** Non-secret durable mailbox realm and its supported single-owner authority domain. */
export interface MailboxIdentity {
  readonly realm: string
  readonly owner: 'single-owner'
}

/** Authoritative absence after authorized same-identity lookup, never inferred from transport errors. */
export interface MailboxNotAccepted { readonly outcome: 'not-accepted' }
