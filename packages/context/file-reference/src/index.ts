/**
 * File-reference discovery seam shared by host-backed user interfaces.
 *
 * @module @deepseek-ai/dsh-file-reference
 */

import { Service, symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import type { FileReferenceCandidate } from './types.ts'

export { activeAtToken, formatFileMention } from './grammar.ts'
export type { ActiveAtToken } from './grammar.ts'
export type { FileReferenceCandidate } from './types.ts'

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
   * Capture synchronous validity of this provider's current discovery scope.
   * This grants no access; callers must separately authorize every resource.
   * @param agent - exact addressed live Agent.
   * @returns final no-await check; dynamic providers additionally bind their own scope generation.
   */
  captureScope(agent: Agent): () => boolean {
    const session = agent.session
    const provider = this.ctx.get('fileReferences')
    const original = (value: FileReferenceService | undefined): FileReferenceService | undefined =>
      value === undefined ? undefined
        : (value as FileReferenceService & { [symbols.original]?: FileReferenceService })[symbols.original] ?? value
    return () => this.ctx.get('agents')?.get(agent.id) === agent && agent.session === session
      && original(this.ctx.get('fileReferences')) === original(provider)
  }

  /**
   * Retain a listed candidate's provider-owned validity until the caller returns it.
   * @param agent - exact addressed Agent, independently authorized by the caller.
   * @param _candidate - candidate returned by this provider's list operation.
   * @returns synchronous guard; providers with mutable backing data bind its identity here.
   */
  captureCandidate(agent: Agent, _candidate: FileReferenceCandidate): () => boolean {
    return this.captureScope(agent)
  }

  /**
   * List file and directory candidates for one agent's working directory.
   * @param agent - target agent whose session cwd bounds discovery.
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
