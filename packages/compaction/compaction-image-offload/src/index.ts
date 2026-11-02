/**
 * Image offload executor for the compaction seam. When an image-capable route
 * fails a request with `IMAGE_OFFLOAD_REQUIRED`, the plugin records one
 * `image/offload` decision selecting the oldest retained input occurrences
 * and retries through the agent or compaction summary error waterfall. Every route
 * sends placeholder text for those occurrences in subsequent requests.
 *
 * A `REQUEST_TOO_LARGE` failure gets the same durable repair: a gateway can cap
 * the encoded body far below the model window, so the token meter may believe a
 * request fits while its image payloads blow the cap. Offloading the oldest half
 * converges in a few rounds and leaves the transcript otherwise intact.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, REQUEST_TOO_LARGE_CODE } from '@deepseek-ai/dsh-llm'
import { offloadOldestImages, retainedImageCount } from './image-offload.ts'
import { imageOffloadProjection } from './projection.ts'

export const name = 'compaction-image-offload'
export const inject = ['agents', 'sessions']

/**
 * Mount agent and summary recovery listeners without configuration.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  ctx.on('agent/request-error', ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
    if (signal.aborted) return next()
    if (failure.code === IMAGE_OFFLOAD_REQUIRED_CODE && failure.offloadImages !== undefined) {
      // A durable surface repair, not a provider retry: it spends no retry budget and logs no retry event.
      if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next()
      return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
    }
    // A gateway rejected the encoded body before the model saw it. Images are
    // the one payload whose encoded size the token meter badly under-prices
    // (base64 inflates them further), so shed the oldest half and retry. The
    // halving converges in a few rounds instead of spending one attempt per
    // image; when nothing is left to shed, a later listener still gets its turn.
    if (failure.code !== REQUEST_TOO_LARGE_CODE) return next()
    const nodes = agent.session.surface.nodes
    const retained = retainedImageCount(agent.session, nodes)
    if (retained === 0) return next()
    const shed = Math.max(1, Math.ceil(retained / 2))
    if (!offloadOldestImages(agent.session, nodes, shed)) return next()
    return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
  })
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }, next) => {
    if (!(error instanceof LlmError)) return next()
    if (error.code === IMAGE_OFFLOAD_REQUIRED_CODE && error.failure.offloadImages !== undefined) {
      signal?.throwIfAborted()
      if (!offloadOldestImages(session, sourceEventSeqs, error.failure.offloadImages)) return next()
      return true
    }
    // The summarizer replays the same history, so it hits the same body cap.
    // Shedding images here lets the summary shrink instead of failing outright.
    if (error.code !== REQUEST_TOO_LARGE_CODE) return next()
    signal?.throwIfAborted()
    const retained = retainedImageCount(session, sourceEventSeqs)
    if (retained === 0) return next()
    if (!offloadOldestImages(session, sourceEventSeqs, Math.max(1, Math.ceil(retained / 2)))) return next()
    return true
  })
}
