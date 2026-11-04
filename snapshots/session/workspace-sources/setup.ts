/** Loader fixture checking Workspace sources in admitted and logged model context. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'

/** Loader identity for the Workspace source-context scenario. */
export const name = 'workspace-sources-snapshot'
/** Shipped services used to prepare the Session and inspect its admitted request. */
export const inject = ['agents', 'sessionPersistence', 'storageDomain', 'workingDirectory', 'sandboxPolicy']

/**
 * Attach the ordinary Session to a Workspace whose primary differs from its original cwd.
 * @param ctx - Loader-owned context retaining the registry and request assertions.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(WorkspaceRegistry)
  const registry = ctx.get('workspaceRegistry')
  assert(registry !== undefined)
  ctx.on('agent/created', async ({ agent }) => {
    const original = agent.session.header.cwd
    assert(original !== undefined)
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
    const workspace = await registry.create(original)
    await workspace.configure('Snapshot sources', [join(original, 'secondary'), original])
    await workspace.attachSession(agent.id)
    assert.deepEqual(ctx.sandboxPolicy.resolve({ session: agent.session }), policy)
    assert.equal(ctx.workingDirectory.get(agent.session), original)
  })
  ctx.on('llm/stream', (request, next) => {
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    assert(agent !== undefined, 'source-context request has no live Agent')
    const original = agent.session.header.cwd
    assert(original !== undefined)
    const sources = [join(original, 'secondary'), original]
    const expected = `Workspace source directories: ${JSON.stringify(sources)}. The first directory is the primary source; the current working directory is reported separately. Directory access follows the current file policy.`
    const context = request.messages.findLast(message => message.role === 'user' && message.source?.kind === 'runtime-context')
    assert(context?.role === 'user' && context.source.kind === 'runtime-context' && context.source.form === 'snapshot')
    assert.deepEqual(context.source.sections.filter(section => section.name === 'workspace:sources'), [
      { name: 'workspace:sources', text: expected },
    ])
    assert.deepEqual(context.source.sections.filter(section => section.name === 'working-directory:current'), [
      { name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(original)}.` },
    ])
    assert.deepEqual(request.messages, agent.session.deriveMessages())
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
    assert.equal(policy.mode, 'read-only')
    assert.equal(policy.workspaceRoot, original)
    assert.equal(policy.additionalWritableRoots, undefined)
    return next()
  })
}
