/** Workspace default directory selections; these values do not authorize execution. */
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { WorkspaceAdditionalRoot } from './types.ts'
import { fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'

/** Canonical existing paths only; a segment boundary keeps sibling prefixes separate. */
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/**
 * Canonicalize explicit selections using Workspace's existing identity policy.
 * Reference means no additional write request, NOT a read sandbox. Reject
 * overlapping reference/write selections rather than advertise false isolation.
 * The primary project is treated as potentially writable for this conflict
 * check; actual deployment grants must also be checked by the future admission
 * owner. This function never grants permissions or creates directories.
 * @param primaryPath - Stored canonical primary Workspace identity, retained even if missing.
 * @param roots - Explicit candidate defaults for future Sessions.
 * @returns detached immutable selections in first-selected order.
 */
export async function normalizeAdditionalRoots(
  primaryPath: string,
  roots: readonly WorkspaceAdditionalRoot[],
): Promise<readonly WorkspaceAdditionalRoot[]> {
  // Detach before I/O: callers cannot change access while canonicalization waits.
  const candidates = roots.map(root => ({ path: root.path, access: root.access }))
  if (!fullyQualifiedWorkspacePath(primaryPath) || primaryPath.includes('\0')) {
    throw new TypeError('Workspace primary identity must be a fully qualified path without NUL')
  }
  // Do not re-resolve an immutable identity or require it to exist to clear defaults.
  const primary = primaryPath
  const result: WorkspaceAdditionalRoot[] = []
  const selected: WorkspaceAdditionalRoot[] = [{ path: primary, access: 'write' }]
  for (const root of candidates) {
    if (root.path.includes('\0')) throw new TypeError('Workspace additional root must not contain NUL')
    const path = await realpathNormalize(root.path)
    if (!(await stat(path)).isDirectory()) throw new TypeError('Workspace additional root must be a directory')
    for (const existing of selected) {
      if (existing.access !== root.access && (contains(existing.path, path) || contains(path, existing.path))) {
        throw new TypeError(`Workspace additional root access conflict: ${JSON.stringify(path)} and ${JSON.stringify(existing.path)}`)
      }
    }
    if (selected.some(existing => existing.path === path)) continue
    const normalized = Object.freeze({ path, access: root.access })
    selected.push(normalized)
    result.push(normalized)
  }
  return Object.freeze(result)
}
