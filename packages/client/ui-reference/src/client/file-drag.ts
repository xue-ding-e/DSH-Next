/** Path-only references from the workspace tree, not browser File uploads. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const FILE_REFERENCE_DRAG = 'application/x-dsh-file-reference'
export interface FileReferenceSource {
  readonly sessionId: SessionId
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** Stage only a Host-resolved path and preserve intervening edits or cancellation. */
export async function stageFileReference(
  input: SessionInput,
  source: FileReferenceSource,
  lookup: (source: FileReferenceSource, signal: AbortSignal) => Promise<FileReferenceCandidate>,
  signal: AbortSignal,
): Promise<'inserted' | 'duplicate' | 'unavailable' | 'changed'> {
  const before = input.state.getSnapshot()
  const insertion = input.captureInsertion()
  signal.throwIfAborted()
  const candidate = await lookup(source, signal)
  signal.throwIfAborted()
  const mention = formatFileMention(candidate, false)
  if (mention === undefined) return 'unavailable'
  const now = input.state.getSnapshot()
  if (now.draftRev !== before.draftRev) return 'changed'
  if (now.occurrences.some(item => item.source === 'reference' && item.ref === mention)) return 'duplicate'
  const basename = candidate.path.split('/').filter(Boolean).at(-1) ?? candidate.path
  return input.insertReference({
    source: 'reference', ref: mention, clipboardText: mention,
    label: candidate.kind === 'directory' ? `${basename}/` : basename,
    appearance: candidate.kind === 'directory' ? 'folder' : 'file',
  }, { ...insertion, start: insertion.end }) ? 'inserted' : 'changed'
}
