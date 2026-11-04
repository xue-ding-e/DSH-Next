/** Confirmed user-message replacements fork and send without mutating the source Session. */
import type { ISessions, PendingSubmissionAttachment, SessionBinding, SessionFace, SessionRetainOptions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserMessageNode, SteeringMessageNode } from '../contract/snapshot.ts'
import type { UserMessageEdit, UserMessageEditResult } from '../contract/slots.ts'

type StageHistory = ClientRemote['fileUploads']['stageHistory']
type HistoryFileUploadRequest = Parameters<StageHistory>[1]
type FileUploadValue = Extract<Awaited<ReturnType<StageHistory>>, { ok: true }>['value']

interface EditDependencies {
  readonly source: Pick<SessionBinding, 'sessionId'>
  readonly sessions: Pick<ISessions, 'fork'> & {
    binding(sessionId: SessionId): Pick<SessionBinding, 'sessionId'> | undefined
    using<T>(sessionId: SessionId, options: SessionRetainOptions, operation: (reference: {
      readonly ready: Promise<Pick<SessionBinding, 'sessionId'> & { readonly session: Pick<SessionFace, 'beginSubmission' | 'prompt'> }>
    }) => T | Promise<T>): Promise<T>
  }
  readonly readImage: (attachment: ImageAttachmentRef, signal: AbortSignal) => Promise<Extract<PromptContentPart, { type: 'image' }>>
  readonly stageFile: (targetId: SessionId, request: HistoryFileUploadRequest, signal: AbortSignal) => Promise<FileUploadValue>
  readonly openSession: (sessionId: SessionId) => void
}

/**
 * Whether a durable human message can be replayed through the current prompt API.
 * Images and files retain their content order; unsupported content kinds cannot be dropped.
 * @param message - projected user or steering row.
 * @returns whether editing can preserve every supported content block.
 */
export function canEditUserMessage(message: UserMessageNode | SteeringMessageNode): message is UserMessageNode {
  return message.kind === 'user' && message.messageId !== undefined && message.seq > 0
    && typeof message.source === 'object' && message.source !== null && 'kind' in message.source && message.source.kind === 'user'
    && message.content.length > 0
    && message.content.every(block => block.type === 'text' || ((block.type === 'image' || block.type === 'file') && 'attachment' in block))
}

function forkFailureCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('rpcError' in error)) return undefined
  const failure = error.rpcError
  return typeof failure === 'object' && failure !== null && 'code' in failure && typeof failure.code === 'string'
    ? failure.code : undefined
}

function forkRefused(error: unknown): boolean {
  const code = forkFailureCode(error)
  return code === 'session/fork-unavailable' || code === 'session/not-found'
    || code === 'session/migration-required' || code === 'session/writer-held' || code === 'gateway/bad-request'
}

function promptRefused(code: string): boolean {
  return code === 'session/attachment-invalid' || code === 'session/agent-busy' || code === 'session/not-found'
    || code === 'session/model-unavailable' || code === 'session/provider-credentials-unavailable'
    || code === 'session/provider-models-unavailable' || code === 'gateway/bad-request'
}

/**
 * Prepare a local transaction; no remote operation starts until submit is called.
 * A created child survives failures. An uncertain send retains its exact request and content,
 * so an explicit retry uses the Host's prompt deduplication. An unknown fork cannot be retried.
 * @param deps - source binding, Session ownership, attachment preparation, and navigation.
 * @param message - eligible immutable source message.
 * @returns one editor-owned submission transaction.
 */
export function createUserMessageEdit(deps: EditDependencies, message: UserMessageNode): UserMessageEdit {
  const messageId = message.messageId
  if (!canEditUserMessage(message) || messageId === undefined) throw new Error('ui-chat: this message cannot be replayed without losing content')
  let childId: SessionId | undefined
  let forkUncertain = false
  let accepted = false
  let submitted: { readonly requestId: Parameters<SessionFace['prompt']>[3]; readonly content: PromptContentPart[] } | undefined
  let images: readonly Extract<PromptContentPart, { type: 'image' }>[] | undefined
  const files = new Map<number, FileUploadValue>()
  let inFlight: Promise<UserMessageEditResult> | undefined

  const prepareImages = async (signal: AbortSignal): Promise<void> => {
    if (images === undefined) {
      const prepared: Extract<PromptContentPart, { type: 'image' }>[] = []
      for (const block of message.content) {
        if (block.type !== 'image' || !('attachment' in block)) continue
        prepared.push(await deps.readImage(block.attachment, signal))
        signal.throwIfAborted()
      }
      images = prepared
    }
  }

  const prepare = async (text: string, targetId: SessionId, signal: AbortSignal) => {
    const content: PromptContentPart[] = []
    const attachments: PendingSubmissionAttachment[] = []
    let replacedText = false
    let imageIndex = 0
    for (const [contentIndex, block] of message.content.entries()) {
      if (block.type === 'text') {
        if (!replacedText) content.push({ type: 'text', text })
        replacedText = true
      } else if (block.type === 'file') {
        let staged = files.get(contentIndex)
        if (staged === undefined) {
          signal.throwIfAborted()
          staged = await deps.stageFile(targetId, {
            sourceSessionId: deps.source.sessionId, messageId, contentIndex, attachmentId: block.attachment.attachmentId,
          }, signal)
          signal.throwIfAborted()
          files.set(contentIndex, staged)
        }
        content.push({ type: 'file', receiptId: staged.receiptId })
        attachments.push({ type: 'file', value: staged.file })
      } else {
        const image = images?.[imageIndex++]
        if (image === undefined) throw new Error('ui-chat: edited image content is unavailable')
        content.push(image)
        attachments.push({ type: 'image', value: { previewUrl: `data:${image.mediaType};base64,${image.data}`,
          ...image.name === undefined ? {} : { name: image.name } } })
      }
    }
    if (!replacedText && text !== '') content.unshift({ type: 'text', text })
    return { content, attachments }
  }

  const submit = async (text: string, signal: AbortSignal): Promise<UserMessageEditResult> => {
    signal.throwIfAborted()
    if (forkUncertain) return { kind: 'failed', reason: 'uncertain-fork' }
    if (deps.sessions.binding(deps.source.sessionId) !== deps.source) return { kind: 'failed', reason: 'retry' }
    try { if (submitted === undefined) await prepareImages(signal) }
    catch (_error: unknown) {
      // Preparation only reads the source; a failed read leaves the source and branch state intact.
      return { kind: 'failed', reason: 'retry' }
    }
    signal.throwIfAborted()
    if (childId === undefined) {
      try {
        childId = await deps.sessions.fork({
          sessionId: deps.source.sessionId, atSeq: message.seq - 1, increaseTitle: true,
          onCreated: (id) => { childId = id },
        })
      } catch (error: unknown) {
        forkUncertain = childId === undefined && !forkRefused(error)
        return { kind: 'failed', reason: forkUncertain ? 'uncertain-fork' : 'retry' }
      }
    }
    signal.throwIfAborted()
    const attempt = { sending: false }
    try {
      return await deps.sessions.using(childId, { source: 'controllerOperation', signal }, async (reference) => {
        const child = await reference.ready
        signal.throwIfAborted()
        if (!accepted) {
          if (submitted === undefined) {
            const { content, attachments } = await prepare(text, child.sessionId, signal)
            signal.throwIfAborted()
            submitted = { requestId: child.session.beginSubmission({ mode: 'queue', text, attachments }).requestId, content }
          }
          attempt.sending = true
          const result = await child.session.prompt(submitted.content, 'queue', signal, submitted.requestId)
          if (!result.ok) {
            const refused = promptRefused(result.error.code)
            if (refused) {
              submitted = undefined
              if (result.error.code === 'session/attachment-invalid') files.clear()
            }
            return { kind: 'failed', reason: refused ? 'retry' : 'uncertain-send' }
          }
          accepted = true
        }
        signal.throwIfAborted()
        deps.openSession(child.sessionId)
        return { kind: 'sent' }
      })
    } catch (_error: unknown) {
      // A lost admission reply retries the same request; navigation failures never resend an accepted prompt.
      return { kind: 'failed', reason: attempt.sending && !accepted ? 'uncertain-send' : 'retry' }
    }
  }
  return {
    submit: (text, signal) => {
      inFlight ??= submit(text, signal).finally(() => { inFlight = undefined })
      return inFlight
    },
  }
}
