/** Host-only recovery index for atomic pending-message handoffs. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from './types.ts'

export interface QueueRecallState {
  readonly ownStart: number
  readonly recalls: readonly { readonly requestId: SessionRequestId; readonly message: UserMessage }[]
}

/** Rebuild retry authority from committed own-Session events, never a fork's inherited operations. */
export const queueRecallProjection: ProjectionDefinition<'queueRecallRecovery', QueueRecallState> = {
  key: 'queueRecallRecovery',
  stateSchema: z.object({
    ownStart: z.number().int().nonnegative(),
    recalls: z.array(z.object({ requestId: z.custom<SessionRequestId>(), message: z.custom<UserMessage>() })),
  }),
  init: (_header, inheritedEventCount): QueueRecallState => ({ ownStart: inheritedEventCount, recalls: [] }),
  apply(state: QueueRecallState, event): QueueRecallState {
    if (event.seq < state.ownStart || event.type !== 'agent/inbox/spliced' || event.data.recall === undefined) return state
    const { recall } = event.data
    if (event.data.target !== 'next-turn' || event.data.removedCount !== 1 || event.data.inserted.length !== 0
      || event.data.outcome !== 'canceled' || recall.message.source.kind !== 'user'
      || state.recalls.some(value => value.requestId === recall.requestId)) {
      throw new Error('invalid persisted queue recall handoff')
    }
    return { ...state, recalls: [...state.recalls, recall] }
  },
  stateVersion: 1,
}
