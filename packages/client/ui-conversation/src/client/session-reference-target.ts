/** Resolve only the originating message's captured identity or a canonical mention URI. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference/uri'

/**
 * Resolve an explicit message-associated identity or canonical mention.
 * @param raw - original reference spelling.
 * @param sessionId - identity associated with this exact message, when available.
 * @returns the exact referenced Session; absent or invalid identity throws before navigation.
 */
export function sessionReferenceTarget(
  raw: string,
  sessionId: SessionId | undefined,
): SessionId {
  if (sessionId !== undefined) return sessionId
  const explicit = parseSessionReferenceText(raw).references
  if (explicit.length === 1 && explicit[0] !== undefined) return explicit[0].sessionId
  throw new Error('Session reference requires an exact target')
}
