import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Session } from '@deepseek-ai/dsh-session'
import { onTestFinished } from 'vitest'

/**
 * Reconstruct a real Agent Inbox through the public factory without a persistence writer.
 * @param seed - synthetic Session whose events and lineage the factory replays.
 * @returns the context-owned production Agent and its reconstructed Session.
 */
export async function recallAgent(seed: Session) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  const { agent } = await ctx.agents.create({
    sessionId: seed.id,
    seed: seed.snapshotEvents(),
    meta: {
      ...seed.header.origin === undefined ? {} : { origin: seed.header.origin },
      ...seed.header.parentSession === undefined ? {} : { parentSession: seed.header.parentSession },
      ...seed.header.isSeeded === undefined ? {} : { isSeeded: seed.header.isSeeded },
    },
    inheritedEventCount: seed.inheritedEventCount,
  })
  // Structural Inbox commands do not wake the model driver.
  return { ctx, agent, session: agent.session, inbox: agent.inbox }
}
