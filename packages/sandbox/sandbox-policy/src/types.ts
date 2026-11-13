/** Browser-safe facts for editing and confirming a Session's directory selection. */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A directory selected for reference or explicit write approval. */
export interface SessionRootRequest {
  readonly path: string
  readonly access: 'reference' | 'write'
}

/** One short-lived, Peer-bound confirmation preview. */
export interface RootApprovalPreview {
  readonly sessionId: SessionId
  readonly nonce: string
  readonly expiresAt: number
  readonly roots: readonly SessionRootRequest[]
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly deploymentWritableRoots: readonly string[]
  readonly rootsRevision: number
  readonly modeRevision: number
  readonly lifetime: 'live-agent'
}

/** Writable directories granted for this live Agent. */
export interface RootApprovalReceipt {
  readonly sessionId: SessionId
  readonly additionalWritableRoots: readonly string[]
  readonly lifetime: 'live-agent'
}

/** Directory selections and current execution authority for one live Agent. */
export interface SessionDirectoryState {
  readonly sessionId: SessionId
  readonly primaryPath: string
  readonly roots: readonly SessionRootRequest[] | null
  readonly rootsRevision: number | null
  readonly mode: SandboxMode
  readonly deploymentWritableRoots: readonly string[]
  readonly confirmedRoots: readonly SessionRootRequest[]
  readonly activeWritableRoots: readonly string[]
  readonly writeSupported: boolean
  readonly lifetime: 'live-agent'
}
