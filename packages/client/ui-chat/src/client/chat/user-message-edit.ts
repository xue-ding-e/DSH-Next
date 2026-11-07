/** Confirmed user-message replacements rerun inside the original Session. */
import type { SessionBinding, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { UserMessageNode, SteeringMessageNode } from '../contract/snapshot.ts'
import type { UserMessageEdit, UserMessageEditResult } from '../contract/slots.ts'

interface EditDependencies {
  readonly source: Pick<SessionBinding, 'sessionId'> & { readonly session: Pick<SessionFace, 'edit'> }
}

/**
 * Whether a durable human message can be edited without dropping content.
 * @param message - conversation node selected by the editor.
 * @returns whether the node is a complete editable user message.
 */
export function canEditUserMessage(message: UserMessageNode | SteeringMessageNode): message is UserMessageNode {
  return message.kind === 'user' && message.messageId !== undefined && message.seq > 0
    && typeof message.source === 'object' && message.source !== null && 'kind' in message.source && message.source.kind === 'user'
    && message.content.length > 0
    && message.content.every(block => block.type === 'text' || ((block.type === 'image' || block.type === 'file') && 'attachment' in block))
}

/**
 * Prepare a same-session edit transaction. The Host validates that the selected
 * message is still the latest editable human prompt, replaces its current
 * conversation generation, and keeps the old log range for audit/replay.
 * @param deps - source Session binding.
 * @param message - eligible immutable source message.
 * @returns one editor-owned submission transaction.
 */
export function createUserMessageEdit(deps: EditDependencies, message: UserMessageNode): UserMessageEdit {
  if (!canEditUserMessage(message)) throw new Error('ui-chat: this message cannot be edited without losing content')
  let accepted = false
  let inFlight: Promise<UserMessageEditResult> | undefined
  const submit = async (text: string, signal: AbortSignal): Promise<UserMessageEditResult> => {
    signal.throwIfAborted()
    if (accepted) return { kind: 'sent' }
    const result = await deps.source.session.edit(message.seq as SessionSeq, message.seq as SessionSeq, text, signal)
    if (!result.ok) {
      const retryable = result.error.code === 'session/edit-stale'
        || result.error.code === 'session/agent-busy'
        || result.error.code === 'session/not-found'
        || result.error.code === 'gateway/bad-request'
      return { kind: 'failed', reason: retryable ? 'retry' : 'uncertain-send' }
    }
    accepted = true
    return { kind: 'sent' }
  }
  return {
    submit: (text, signal) => {
      inFlight ??= submit(text, signal).finally(() => { inFlight = undefined })
      return inFlight
    },
  }
}
