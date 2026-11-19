/** Skill invocation policy for the authored creation-recommendations replay. */

export const name = 'creation-recommendations-skill-policy'
export const inject = ['skills']

/**
 * Shadow the platform-specific bundled skill so the fixture can share one recorded catalog.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the test profile's plugin context.
 */
export function apply(ctx) {
  ctx.skills.register({
    name: 'diagnose-windows-sandbox-acl',
    description: 'Windows ACL diagnosis is outside this fixture.',
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: false },
    content: '',
  })
}
