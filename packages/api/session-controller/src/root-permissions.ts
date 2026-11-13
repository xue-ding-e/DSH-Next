/** Owner Remote orchestration for explicit, process-local directory grants. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RootApprovalError } from '@deepseek-ai/dsh-sandbox-policy'
import type { RootApprovalPreview, RootApprovalReceipt, SessionDirectoryState, SessionRootRequest } from '@deepseek-ai/dsh-sandbox-policy/types'

function requireAgent(ctx: Context, sessionId: SessionId): Agent {
  const invocation = ctx.invocation
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- remote drivers extend PrincipalMap with non-owner identities.
  if (invocation === undefined || invocation.peer.principal.kind !== 'owner') {
    throw new RemoteError('session/roots-owner-required', 'Directory permissions require an authenticated owner Remote call', {})
  }
  invocation.signal.throwIfAborted()
  invocation.peer.signal.throwIfAborted()
  const agent = ctx.get('agents')?.get(sessionId)
  if (agent === undefined) throw new RemoteError('session/roots-unavailable', 'The selected Agent is not live', {})
  return agent
}

/** Capture exact resource providers; unavailable or changing scopes never mean idle. */
function activityFence(agent: Agent): () => void {
  const ctx = agent.ctx
  const terminals = ctx.get('terminals')
  const jobs = ctx.get('jobs')
  const subagents = ctx.get('subagents')
  if (terminals === undefined || jobs === undefined || subagents === undefined) {
    throw new RootApprovalError('Directory confirmation requires all activity providers to be available')
  }
  return () => {
    if (identity(ctx.get('terminals')) !== identity(terminals) || identity(ctx.get('jobs')) !== identity(jobs)
      || identity(ctx.get('subagents')) !== identity(subagents)) {
      throw new RootApprovalError('Activity providers changed; preview again')
    }
    if (terminals.hasOwnerActivity(agent) || subagents.hasOwnerActivity(agent)
      || jobs.list(agent.id).some(job => job.owner === agent.id && (job.status === 'running' || job.status === 'stopping'))) {
      throw new RootApprovalError('Close terminals and wait for jobs and descendant work before confirming directories')
    }
  }
}

async function explain<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation() } catch (error: unknown) {
    if (error instanceof RootApprovalError) throw new RemoteError('session/roots-refused', error.message, {})
    throw error
  }
}

/**
 * Preview the selection without starting a turn.
 * @param ctx - authenticated invocation context.
 * @param sessionId - active Session.
 * @returns the Peer's one-use preview.
 */
export function prepareSessionRoots(ctx: Context, sessionId: SessionId): Promise<RootApprovalPreview> {
  return explain(() => {
    const agent = requireAgent(ctx, sessionId)
    const policy = agent.ctx.extend({ invocation: ctx.invocation }).get('sandboxPolicy')
    if (policy === undefined) throw new RootApprovalError('Directory permission policy is unavailable')
    return policy.prepareRootApproval(agent, activityFence(agent))
  })
}

/**
 * Confirm the current Peer's one-use preview.
 * @param ctx - authenticated invocation context.
 * @param sessionId - active Session.
 * @param nonce - matching preview nonce.
 * @returns the live grant receipt.
 */
export function confirmSessionRoots(ctx: Context, sessionId: SessionId, nonce: string): Promise<RootApprovalReceipt> {
  return explain(() => {
    const agent = requireAgent(ctx, sessionId)
    const policy = agent.ctx.extend({ invocation: ctx.invocation }).get('sandboxPolicy')
    if (policy === undefined) throw new RootApprovalError('Directory permission policy is unavailable')
    return policy.confirmRootApproval(agent, nonce)
  })
}

/**
 * Discard the current Peer's matching preview.
 * @param ctx - authenticated invocation context.
 * @param sessionId - active Session.
 * @param nonce - preview nonce.
 */
export function cancelSessionRoots(ctx: Context, sessionId: SessionId, nonce: string): Promise<void> {
  return explain(() => {
    const agent = requireAgent(ctx, sessionId)
    const policy = agent.ctx.extend({ invocation: ctx.invocation }).get('sandboxPolicy')
    if (policy === undefined) throw new RootApprovalError('Directory permission policy is unavailable')
    policy.cancelRootApproval(agent, nonce)
  })
}

/** Compare provider generations rather than Cordis contextual views. */
function identity<T extends object>(service: T | undefined): T | undefined {
  return service === undefined ? undefined : (service as T & { [symbols.original]?: T })[symbols.original] ?? service
}

/**
 * Read the current selection and live authorization.
 * @param ctx - authenticated invocation context.
 * @param sessionId - active Session.
 * @returns current directory facts.
 */
export function readSessionRoots(ctx: Context, sessionId: SessionId): Promise<SessionDirectoryState> {
  return explain(() => {
    const agent = requireAgent(ctx, sessionId)
    const policy = agent.ctx.extend({ invocation: ctx.invocation }).get('sandboxPolicy')
    if (policy === undefined) throw new RootApprovalError('Directory permission policy is unavailable')
    return policy.directoryState(agent)
  })
}

/**
 * Save a pending directory selection.
 * @param ctx - authenticated invocation context.
 * @param sessionId - active Session.
 * @param roots - complete replacement selection.
 * @param expectedRevision - revision read by the editor, or null.
 * @returns current directory facts after the save.
 */
export function replaceSessionRoots(ctx: Context, sessionId: SessionId, roots: readonly SessionRootRequest[],
  expectedRevision: number | null): Promise<SessionDirectoryState> {
  return explain(() => {
    const agent = requireAgent(ctx, sessionId)
    const policy = agent.ctx.extend({ invocation: ctx.invocation }).get('sandboxPolicy')
    if (policy === undefined) throw new RootApprovalError('Directory permission policy is unavailable')
    return policy.replaceRequestedRoots(agent, roots, expectedRevision, activityFence(agent))
  })
}
