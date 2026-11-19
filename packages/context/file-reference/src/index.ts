/**
 * File-reference discovery seam shared by host-backed user interfaces.
 *
 * @module @deepseek-ai/dsh-file-reference
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import type { FileReferenceCandidate } from './types.ts'

export { activeAtToken, formatFileMention } from './grammar.ts'
export type { ActiveAtToken, FileReferenceCandidate } from './types.ts'

/** Model guidance for path-only references selected by a user interface. */
export const FILE_REFERENCE_PROMPT = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileReferences: FileReferenceService
  }
}

/** Host capability for cancellable file-reference discovery. */
export abstract class FileReferenceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileReferences')
  }

  /**
   * Capture the provider's current discovery scope for an authorized Agent.
   * @param _agent - exact active Agent.
   * @returns a final synchronous guard; unsupported providers refuse path drops.
   */
  captureScope(_agent: Agent): () => boolean {
    return () => false
  }

  /**
   * Capture the identity of a provider-issued candidate.
   * @param _agent - authorized Agent used to list the candidate.
   * @param _candidate - candidate returned by list.
   * @returns a final synchronous guard; unsupported providers refuse path drops.
   */
  captureCandidate(_agent: Agent, _candidate: FileReferenceCandidate): () => boolean {
    return () => false
  }

  /**
   * List candidates confined to the Session's current working directory.
   * Providers that cannot enforce this scope return no candidates.
   * @param _agent - target Agent.
   * @param _query - path text following `@` or `@"`.
   * @param _signal - caller cancellation.
   * @returns path-only candidates in the current directory.
   */
  listWorkingDirectory(_agent: Agent, _query: string, _signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    return Promise.resolve([])
  }

  /**
   * List candidates from the working directory and confirmed Session roots.
   * @param agent - target Agent whose Session supplies the discovery scope.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates.
   */
  abstract list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]>
}

export default FileReferenceService
