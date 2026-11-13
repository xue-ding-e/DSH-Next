/** Pending directory selections restored from a Session log without restoring authority. */
import { posix, win32 } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionRootRequest } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete directory selection. Replay restores requests only. */
    'sandbox/roots-requested': { roots: readonly SessionRootRequest[] }
  }
}

/** Directory selection parser for incoming requests and restored events. */
export const requestedRootsSchema = z.array(z.object({
  path: z.string().refine(path => !path.includes('\0') && (posix.isAbsolute(path)
    || (win32.isAbsolute(path) && win32.parse(path).root !== '\\'))),
  access: z.enum(['reference', 'write']),
}).strict().readonly()).readonly()

/** Checkpoint state retains only the current selection and its approval revisions. */
export const requestedRootsStateSchema = z.object({
  roots: requestedRootsSchema.nullable(),
  started: z.boolean(),
  rootsRevision: z.number().int().nonnegative(),
  modeRevision: z.number().int().nonnegative(),
})

/** Projected Session facts. Grants have their own process-local owner. */
export type RequestedRootsState = z.infer<typeof requestedRootsStateSchema>

/**
 * Restore directory requests and the creation-time admission condition.
 * @param state - prior projected facts.
 * @param event - committed Session event.
 * @returns the updated facts, or the same state for unrelated events.
 */
export function foldRequestedRoots(state: RequestedRootsState, event: SessionEvent): RequestedRootsState {
  if (event.type === 'turn/start') return state.started ? state : { ...state, started: true }
  if (event.type === 'sandbox/mode') return { ...state, modeRevision: event.seq }
  if (event.type !== 'sandbox/roots-requested') return state
  return { ...state, roots: requestedRootsSchema.parse(event.data.roots), rootsRevision: event.seq }
}
