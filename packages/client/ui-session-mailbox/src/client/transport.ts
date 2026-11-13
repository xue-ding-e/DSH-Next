/** Narrow UI operations over the generated mailbox Remote namespace. */
import type { MailboxRoute, MailboxOperation, MailboxHandle, MailboxNotAccepted } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'
import type { MailboxMessage } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'

/** The view consumes only these Remote methods, never a Host selection issuer. */
export interface MailboxRemote {
  grant(this: void, route: MailboxRoute): Promise<MailboxHandle>
  prepare(this: void, grant: string, operation: MailboxOperation): Promise<MailboxHandle>
  execute(this: void, selection: string, signal: AbortSignal): Promise<MailboxMessage | readonly MailboxMessage[] | MailboxNotAccepted>
  revoke(this: void, grant: string): Promise<void>
}

/**
 * Execute one operation and withdraw its route even after a late grant.
 * @param remote - mailbox Remote calls.
 * @param route - selected operation and Sessions.
 * @param operation - body allowed by the route.
 * @param signal - lifetime of the initiating UI action.
 * @returns the receipt, inbox, or authoritative refusal.
 */
export async function selectedOperation(
  remote: MailboxRemote,
  route: MailboxRoute,
  operation: MailboxOperation,
  signal: AbortSignal,
): Promise<MailboxMessage | readonly MailboxMessage[] | MailboxNotAccepted> {
  signal.throwIfAborted()
  const { handle } = await remote.grant(route)
  const cancel = (): void => { void remote.revoke(handle).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const selected = await remote.prepare(handle, operation)
    signal.throwIfAborted()
    const result = await remote.execute(selected.handle, signal)
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', cancel)
    // Best-effort transport cleanup is bounded by the Host grant's independent TTL.
    void remote.revoke(handle).catch(() => {})
  }
}
