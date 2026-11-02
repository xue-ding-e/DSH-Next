/**
 * Local-filesystem implementation of `ctx.fileReferences`.
 *
 * @module @deepseek-ai/dsh-file-reference-local
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { Context, symbols } from '@deepseek-ai/cordis'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FileReferenceService, {
  FILE_REFERENCE_PROMPT,
  type FileReferenceCandidate,
} from '@deepseek-ai/dsh-file-reference'
import type {} from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
  type FileSearchConfig,
} from './search.ts'

export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
} from './search.ts'
export type { FileSearchConfig } from './search.ts'
export { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** Local file-reference discovery configuration. */
export interface Config {
  /** Maximum ranked candidates returned for one query. */
  maxResults?: number
  /** Maximum indexed files and directories per agent workspace. */
  maxEntries?: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories?: string[]
}

/** Local-filesystem owner of the file-reference discovery service. */
export class LocalFileReferenceService extends FileReferenceService {
  static inject = ['agents', 'workingDirectory']
  static Config: z<Config> = z.object({
    maxResults: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_RESULTS),
    maxEntries: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES),
    excludedDirectories: z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES]),
  })

  private readonly candidateChecks = new WeakMap<FileReferenceCandidate, { agent: Agent; valid: () => boolean }>()
  private readonly config: FileSearchConfig
  private readonly searches = new Map<Agent, { key: string; searches: Map<string, WorkspaceFileSearch> }>()
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  private readonly promptDisposals = new Set<Promise<void>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = {
      maxResults: config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries: config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories: config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
    }
    validateConfig(this.config)

    const installPrompt = (agent: Agent): ReturnType<Context['inject']> => {
      const existing = this.promptFibers.get(agent)
      if (existing !== undefined) return existing
      const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
        scope.systemPrompt.section({
          name: 'context:file-reference',
          order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
          text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
        })
      })
      this.promptFibers.set(agent, fiber)
      return fiber
    }
    const disposePrompt = (agent: Agent): void => {
      const fiber = this.promptFibers.get(agent)
      if (fiber === undefined) return
      this.promptFibers.delete(agent)
      const task = fiber.dispose().catch((error: unknown) => {
        ctx.logger.warn(`file-reference-local: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.promptDisposals.add(task)
      void task.finally(() => {
        this.promptDisposals.delete(task)
      })
    }
    for (const agent of ctx.agents.list()) installPrompt(agent)
    ctx.on('agent/created', async ({ agent }) => { await installPrompt(agent) })
    ctx.on('agent/disposed', ({ agent }) => {
      this.searches.get(agent)?.searches.forEach((search) => { search.dispose() })
      this.searches.delete(agent)
      disposePrompt(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) this.searches.get(agent)?.searches.forEach((search) => { search.invalidate() })
    })
    ctx.effect(() => async () => {
      for (const { searches } of this.searches.values()) searches.forEach((search) => { search.dispose() })
      this.searches.clear()
      const promptFibers = [...this.promptFibers.values()]
      this.promptFibers.clear()
      await Promise.all([
        ...promptFibers.map(fiber => fiber.dispose()),
        ...this.promptDisposals,
      ])
    }, 'file-reference-local: search cache')
  }

  /** Capture exact live identity and the existing policy owner's confirmed selection, never pending roots. */
  override captureScope(agent: Agent): () => boolean {
    const session = agent.session
    const workingDirectory = agent.ctx.get('workingDirectory')
    if (workingDirectory === undefined) return () => false
    const cwd = workingDirectory.get(session)
    const policy = agent.ctx.get('sandboxPolicy')
    const confirmed = policy?.confirmedRootsOf(session)
    const directories = [...new Set([cwd, ...confirmed?.map(root => root.path) ?? []])]
    const disk = directories.map(rootIdentitySync)
    const fs = identity(agent.ctx.get('fs'))
    const provider = identity(this.ctx.get('fileReferences'))
    const directory = identity(agent.ctx.get('workingDirectory'))
    return () => this.ctx.agents.get(agent.id) === agent && agent.session === session
      && identity(this.ctx.get('fileReferences')) === provider
      && identity(agent.ctx.get('workingDirectory')) === directory
      && agent.ctx.get('workingDirectory')?.get(session) === cwd
      && identity(agent.ctx.get('fs')) === fs
      && directories.every((root, index) => rootIdentitySync(root) === disk[index])
      && identity(agent.ctx.get('sandboxPolicy')) === identity(policy)
      && (confirmed === undefined || confirmed.length === 0
        ? (agent.ctx.get('sandboxPolicy')?.confirmedRootsOf(session).length ?? 0) === 0
        : agent.ctx.get('sandboxPolicy')?.confirmedRootsOf(session) === confirmed)
  }

  /** Retain only genuine list results, including every directory and the leaf identity. */
  override captureCandidate(agent: Agent, candidate: FileReferenceCandidate): () => boolean {
    const captured = this.candidateChecks.get(candidate)
    return captured?.agent === agent ? captured.valid : () => false
  }

  override async list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    const workingDirectory = agent.ctx.get('workingDirectory')
    if (workingDirectory === undefined) return []
    const cwd = await workingDirectory.ensure(agent, signal)
    const valid = this.captureScope(agent)
    if (!valid()) return []
    const roots = [...new Set([cwd, ...agent.ctx.get('sandboxPolicy')?.confirmedRootsOf(agent.session).map(root => root.path) ?? []])]
    const key = JSON.stringify(roots)
    let cached = this.searches.get(agent)
    if (cached?.key !== key) {
      cached?.searches.forEach((search) => { search.dispose() })
      const config = { ...this.config, maxEntries: Math.max(1, Math.floor(this.config.maxEntries / roots.length)) }
      cached = { key, searches: new Map(roots.map(root => [root, new WorkspaceFileSearch(root, config)])) }
      this.searches.set(agent, cached)
    }
    const candidates = new Map<string, FileReferenceCandidate>()
    for (const [root, search] of cached.searches) {
      // The granted root may have been replaced on disk since confirmation.
      // Do not traverse a symbolic alias or return results from another inode.
      const before = await rootIdentity(root)
      signal.throwIfAborted()
      if (!valid()) return []
      if (before === undefined) continue
      const found = await search.list(query, signal)
      const after = await rootIdentity(root)
      if (after !== before) return []
      signal.throwIfAborted()
      if (!valid()) return []
      for (const candidate of found) {
        // Primary relative spellings stay compatible. Additional roots retain
        // absolute identity so same-named entries never silently rebind to cwd.
        const path = root === cwd || isAbsolute(candidate.path) ? candidate.path : resolve(root, candidate.path).split(sep).join('/')
        const snapshot = candidateIdentitySync(root, resolve(root, candidate.path), candidate.kind)
        if (snapshot === undefined) continue
        const listed = { ...candidate, path }
        this.candidateChecks.set(listed, { agent, valid: () => valid()
          && candidateIdentitySync(root, resolve(root, candidate.path), candidate.kind) === snapshot })
        candidates.set(path, listed)
      }
    }
    if (!valid()) return []
    return [...candidates.values()].filter(candidate => this.captureCandidate(agent, candidate)())
      .slice(0, this.config.maxResults)
  }
}

function validateConfig(config: FileSearchConfig): void {
  if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
    throw new Error('file-reference-local: maxResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
    throw new Error('file-reference-local: maxEntries must be a positive safe integer')
  }
  if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
    throw new Error('file-reference-local: excludedDirectories entries must be non-empty directory basenames')
  }
}

export default LocalFileReferenceService

/** Compare underlying Cordis provider generations rather than contextual proxy wrappers. */
function identity<T extends object>(service: T | undefined): T | undefined {
  return service === undefined ? undefined : (service as T & { [symbols.original]?: T })[symbols.original] ?? service
}

/** Canonical directory identity, without following a replacement symbolic root. */
async function rootIdentity(root: string): Promise<string | undefined> {
  try {
    const status = await lstat(root)
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(root) !== resolve(root)) return undefined
    return `${status.dev}:${status.ino}`
  } catch { return undefined }
}

/** Final synchronous metadata check; a changed root never authorizes a stale lookup result. */
function rootIdentitySync(root: string): string | undefined {
  try {
    const status = lstatSync(root)
    if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(root) !== resolve(root)) return undefined
    return `${status.dev}:${status.ino}`
  } catch { return undefined }
}

/** Path metadata only: reject aliases and replacements in every root-to-leaf component. */
function candidateIdentitySync(root: string, path: string, kind: FileReferenceCandidate['kind']): string | undefined {
  try {
    const suffix = relative(root, path)
    if (isAbsolute(suffix) || suffix.split(sep).includes('..')) return undefined
    const components = suffix === '' ? [] : suffix.split(sep)
    let current = resolve(root)
    const identities: string[] = []
    for (let index = 0; index <= components.length; index++) {
      const component = components[index - 1]
      if (component !== undefined) current = resolve(current, component)
      const status = lstatSync(current)
      const leaf = index === components.length
      if (status.isSymbolicLink() || realpathSync(current) !== current
        || (leaf && kind === 'file' ? !status.isFile() : !status.isDirectory())) return undefined
      identities.push(`${status.dev}:${status.ino}`)
    }
    return identities.join('/')
  } catch { return undefined }
}
