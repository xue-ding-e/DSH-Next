/** Workspace identity stays authoritative while the native capability check is in flight. */
import type { WorkspaceSnapshot, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

interface FolderRemote {
  canOpenWorkspacePath: () => Promise<{ ok: true; value: boolean } | { ok: false }>
  openWorkspacePath: (request: { path: string }, signal: AbortSignal) => Promise<{ ok: true; value: { opened: true } } | { ok: false }>
}

/**
 * Bind one deduplicated directory-opening action to the existing authenticated Host opener.
 * @param workspaces - current Host Workspace mirror; stale snapshots cannot choose a path.
 * @param remote - existing capability and filesystem-verified native opener.
 * @param failed - visible failure feedback owned by the workspace UI.
 * @param generationSignal - current connection/plugin lifetime; reset and disposal abort it.
 * @returns a callback accepting only the clicked Workspace identity, never an arbitrary path.
 */
export function createWorkspaceFolderOpener(
  workspaces: { list: { getSnapshot: () => Pick<WorkspaceSnapshot, 'phase' | 'state' | 'items'> } },
  remote: FolderRemote,
  failed: () => void,
  generationSignal: () => AbortSignal,
): (workspaceId: WorkspaceId) => void {
  const pending = new Map<WorkspaceId, AbortSignal>()
  return (workspaceId) => {
    const signal = generationSignal()
    if (signal.aborted || pending.get(workspaceId) === signal) return
    pending.set(workspaceId, signal)
    const open = async (): Promise<void> => {
      const before = workspaces.list.getSnapshot()
      const workspace = before.phase === 'ready' && before.state === 'idle'
        ? before.items.find(item => item.workspaceId === workspaceId) : undefined
      if (workspace === undefined) throw new Error('Workspace is unavailable')
      const capability = await remote.canOpenWorkspacePath()
      signal.throwIfAborted()
      if (!capability.ok || !capability.value) throw new Error('Native folder opening is unavailable')
      const current = workspaces.list.getSnapshot()
      if (current.phase !== 'ready' || current.state !== 'idle'
        || !current.items.some(item => item.workspaceId === workspaceId && item.path === workspace.path)) {
        throw new Error('Workspace changed before folder opening')
      }
      const result = await remote.openWorkspacePath({ path: workspace.path }, signal)
      if (!result.ok) throw new Error('Native folder opening failed')
    }
    void open().catch(() => {
      if (!signal.aborted) failed()
    }).finally(() => {
      if (pending.get(workspaceId) === signal) pending.delete(workspaceId)
    })
  }
}
