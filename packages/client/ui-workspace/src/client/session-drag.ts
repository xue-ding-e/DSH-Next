/** Browser-safe conversation reference payload shared by sidebar drag sources. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference/uri'

/** Native drag format accepted by the conversation composer. */
export const SESSION_REFERENCE_DRAG_TYPE = 'application/x-dsh-session-reference'

/**
 * Write a structured conversation reference without a filesystem or attachment payload.
 * @param transfer - current native drag data.
 * @param sessionId - conversation to reference.
 * @param label - title displayed by the composer chip.
 */
export function writeSessionReference(transfer: DataTransfer, sessionId: SessionId, label: string): void {
  const mention = formatSessionReferenceMention({ sessionId, label })
  transfer.setData(SESSION_REFERENCE_DRAG_TYPE, JSON.stringify({ sessionId, label, mention }))
}
