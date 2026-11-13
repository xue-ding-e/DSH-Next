/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and invalid-account pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { workspaceAdditionalRoots, type WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceAdditionalRoot, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'
import { normalizeAdditionalRoots, rootsOverlap } from './additional-roots.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/** A source directory list failed validation before the Workspace was changed. */
export class WorkspaceSourcesInvalidError extends Error {
  /**
   * @param message - Invalid source.
   * @param options - Original filesystem failure, when any.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceSourcesInvalidError'
  }
}

/** An attach request named a Session already accounted to another Workspace. */
export class WorkspaceSessionOwnedError extends Error {
  /**
   * @param sessionId - Session whose existing owner prevents attachment.
   * @param workspaceId - Workspace retaining the Session's account.
   */
  constructor(readonly sessionId: SessionId, readonly workspaceId: WorkspaceId) {
    super(`cannot attach session '${sessionId}': workspace '${workspaceId}' already accounts it`)
    this.name = 'WorkspaceSessionOwnedError'
  }
}

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, the canonical session-path
 * index backing the `sessionIds` projection, and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Validate an already-accounted session, preserving ownership when its fully
   * qualified cwd cannot resolve because a path component is missing.
   * @param id - Session already present in this workspace's candidate account.
   * @param path - Workspace's stored canonical directory.
   * @returns whether the candidate remains a member.
   */
  candidateMatches(id: SessionId, path: string): boolean

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, session-path index, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get sourcePaths(): readonly string[] {
    return this.record.sourcePaths ?? [this.record.path]
  }

  get primaryPath(): string {
    return this.record.sourcePaths?.[0] ?? this.record.path
  }

  get additionalRoots(): readonly WorkspaceAdditionalRoot[] {
    return Object.freeze((this.record.additionalRoots ?? []).map(root => Object.freeze({ ...root })))
  }

  async setAdditionalRoots(roots: readonly WorkspaceAdditionalRoot[]): Promise<void> {
    const primary = this.primaryPath
    let normalized: readonly WorkspaceAdditionalRoot[]
    try {
      normalized = await normalizeAdditionalRoots(primary, workspaceAdditionalRoots.parse(roots))
    } catch (error) {
      throw new WorkspaceSourcesInvalidError('Invalid additional directory defaults', { cause: error })
    }
    await this.mutate((record) => {
      if ((record.sourcePaths?.[0] ?? record.path) !== primary) {
        throw new WorkspaceSourcesInvalidError('Workspace primary directory changed while validating the defaults')
      }
      const previous = record.additionalRoots ?? []
      if (previous.length === normalized.length && previous.every((root, index) =>
        root.path === normalized[index]?.path && root.access === normalized[index]?.access)) return record
      return { ...record, additionalRoots: [...normalized] }
    })
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    const paths = [this.path, ...this.sourcePaths, ...(this.record.retainedSourcePaths ?? [])]
    return this.record.sessionIds.filter(id => paths.some(path => this.host.candidateMatches(id, path)))
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async configure(title: string, sourcePaths?: readonly string[]): Promise<void> {
    if (sourcePaths === undefined) return this.setTitle(title)
    if (sourcePaths.length === 0) throw new WorkspaceSourcesInvalidError('a Workspace requires at least one source directory')
    const canonical: string[] = []
    for (const path of sourcePaths) {
      let resolved: string
      try {
        resolved = this.sourcePaths.includes(path) ? path : await realpathNormalize(path)
        if (!this.sourcePaths.includes(resolved) && !(await stat(resolved)).isDirectory()) {
          throw new Error('not a directory')
        }
      } catch (error) {
        throw new WorkspaceSourcesInvalidError(`Workspace source '${path}' is not an accessible directory`, { cause: error })
      }
      if (canonical.includes(resolved)) throw new WorkspaceSourcesInvalidError(`Workspace source '${path}' is duplicated`)
      canonical.push(resolved)
    }
    await this.mutate((record) => {
      const primary = canonical[0]
      if (primary !== undefined && primary !== (record.sourcePaths?.[0] ?? record.path)
        && record.additionalRoots?.some(root => root.access === 'reference' && rootsOverlap(primary, root.path))) {
        throw new WorkspaceSourcesInvalidError('The new primary directory overlaps a reference directory default')
      }
      const priorPaths = new Set([...(record.sourcePaths ?? []), ...(record.retainedSourcePaths ?? [])])
      const retainedSourcePaths = [...priorPaths].filter(path => path !== record.path && !canonical.includes(path)
        && record.sessionIds.some(id => this.host.candidateMatches(id, path)))
      return { ...record, title, sourcePaths: canonical, retainedSourcePaths }
    })
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: its immutable header cwd was checked when it first attached, and
    // removed sources retain that existing ownership. Membership itself is
    // decided on the write chain inside `mutate`, never on this snapshot.
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      let cwd: string
      try {
        cwd = await realpathNormalize(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path && !this.sourcePaths.includes(cwd)) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate((record) => {
      if (record.sessionIds.includes(sessionId)) return record
      for (const [id, candidate] of this.host.table().entries()) {
        if (id !== this.id && candidate.sessionIds.includes(sessionId)) {
          throw new WorkspaceSessionOwnedError(sessionId, id)
        }
      }
      if (![record.path, ...(record.sourcePaths ?? [])].some(path => this.host.candidateMatches(sessionId, path))) {
        throw new WorkspaceSourcesInvalidError(`cannot attach session '${sessionId}': its directory is no longer a Workspace source`)
      }
      return { ...record, sessionIds: [sessionId, ...record.sessionIds] }
    })
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate(record => record.sessionIds.includes(sessionId)
      ? { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) }
      : record)
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning candidates that no
   * longer pass the candidate membership check, then swap the
   * snapshot.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const paths = [changed.path, ...(changed.sourcePaths ?? []), ...(changed.retainedSourcePaths ?? [])]
        const sessionIds = changed.sessionIds.filter(
          id => paths.some(path => this.host.candidateMatches(id, path)),
        )
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}
