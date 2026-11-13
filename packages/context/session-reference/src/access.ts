/** Resource-level authorization for captured session context. */
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import { SessionReferenceError } from './config.ts'

/**
 * Check an unrestricted resource grant, not permission for one history page.
 * Conditional policies receive no fabricated request arguments and must refuse
 * when their required page or prompt restrictions cannot be established.
 * @param access - currently mounted decision service; absence denies non-owners.
 * @param principal - Host-recorded caller, absent for trusted local input.
 * @param sessionId - source or destination Session identity.
 * @param action - source history read or destination prompt admission.
 * @returns whether the caller has the resource-level grant.
 */
export function mayReferenceSession(
  access: Pick<RemoteAccessService, 'decide'> | undefined,
  principal: Principal | undefined,
  sessionId: SessionId,
  action: 'session/page' | 'session/prompt',
): boolean {
  if (principal === undefined || principal.kind === 'owner') return true
  return access?.decide({ principal, action, resources: [{ kind: 'session', id: sessionId }] }).kind === 'allow'
}

/**
 * Refuse capture without exposing the source's identity or contents.
 * @param allowed - result from the shared authorization service.
 */
export function requireReferenceAccess(allowed: boolean): void {
  if (!allowed) throw new SessionReferenceError('Session reference access is no longer available.', 'SESSION_REFERENCE_ACCESS_DENIED')
}
