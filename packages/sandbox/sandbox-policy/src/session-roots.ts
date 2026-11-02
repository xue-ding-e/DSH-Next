/** Pending Session directory requests. Replay is never execution authorization. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One explicit selection; reference does not impose a read sandbox. */
export interface SessionRootRequest {
  /** Absolute execution-world directory selected by the Host. */
  readonly path: string
  /** A write request is pending, not a permission grant. */
  readonly access: 'reference' | 'write'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required-on-read complete directory request snapshot; never proof of user authorization. */
    'sandbox/roots-requested': {
      roots: readonly SessionRootRequest[]
    }
  }
}

/** Parser for log payloads and Host requests at the durable boundary. */
export const requestedRootsSchema = z.array(z.object({
  path: z.string().refine(path => isAbsolute(path) && !path.includes('\0')),
  access: z.enum(['reference', 'write']),
}).strict().readonly()).readonly()

/** One bounded fold; turn history is represented by a single admission bit. */
export const requestedRootsStateSchema = z.object({
  roots: requestedRootsSchema.nullable(),
  started: z.boolean(),
})

/** Host-only projection state; no activation or approval field exists. */
export type RequestedRootsState = z.infer<typeof requestedRootsStateSchema>

/**
 * Restore requested directories and the capture admission boundary, without I/O.
 * @param state - Previous complete state.
 * @param event - Committed event under replay or live projection drive.
 * @returns the next state; unrelated events preserve reference identity.
 */
export function foldRequestedRoots(state: RequestedRootsState, event: SessionEvent): RequestedRootsState {
  if (event.type === 'turn/start') return state.started ? state : { ...state, started: true }
  if (event.type !== 'sandbox/roots-requested') return state
  // Parse restored payloads here: a log can supply values without a typed Host caller.
  return { ...state, roots: requestedRootsSchema.parse(event.data.roots) }
}
