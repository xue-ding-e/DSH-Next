/** Browser-safe directory selection and explicit confirmation vocabulary. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox/types'

/** One explicit selection; reference does not impose a read sandbox. */
export interface SessionRootRequest {
  /** Absolute execution-world directory selected by the Host. */
  readonly path: string
  /** A write request is pending, not a permission grant. */
  readonly access: 'reference' | 'write'
}

/** One Peer-bound, short-lived preview; a nonce is not a durable grant. */
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
  /** Grants last only for this exact live Agent in this Host process. */
  readonly lifetime: 'live-agent'
}

/** Acknowledges an in-process grant, not a portable permission record. */
export interface RootApprovalReceipt {
  readonly sessionId: SessionId
  readonly additionalWritableRoots: readonly string[]
  readonly lifetime: 'live-agent'
}

/** Current process facts; persisted selections never prove activation. */
export interface SessionDirectoryState {
  readonly sessionId: SessionId
  readonly primaryPath: string
  readonly roots: readonly SessionRootRequest[] | null
  readonly rootsRevision: number | null
  readonly mode: SandboxMode
  readonly deploymentWritableRoots: readonly string[]
  /** Canonical selections explicitly confirmed for this exact live Agent. */
  readonly confirmedRoots: readonly SessionRootRequest[]
  readonly activeWritableRoots: readonly string[]
  readonly writeSupported: boolean
  readonly lifetime: 'live-agent'
}
