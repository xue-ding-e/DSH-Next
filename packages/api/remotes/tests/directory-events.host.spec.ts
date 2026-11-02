/** The actual application event source applies Session ACLs even to invalidation-only frames. */
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { afterEach, expect, it } from 'vitest'
import { cleanupRootPermissionsFixture, rootPermissionsFixture } from '../../session-controller/tests/root-permissions-fixture.ts'
import { apply, inject } from '../src/index.ts'

afterEach(cleanupRootPermissionsFixture)

it('forwards directory invalidation only for the granted Session, not global or sibling activity', async () => {
  const { ctx, agent } = await rootPermissionsFixture()
  await ctx.plugin({ inject: [...inject], apply })
  const peer = new Peer(ctx, { principal: { kind: 'root-test-guest' } })
  ctx.remoteAccess.registerPolicy('root-test-guest', { bindings: () => [{
    role: { name: 'directory-event-reader', resource: 'session', actions: ['event:api-session/directories-changed'] },
    resource: { kind: 'session', id: agent.id },
  }] })
  const controller = new AbortController()
  const stream = (await ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, controller.signal))[Symbol.asyncIterator]()
  try {
    expect((await stream.next()).value).toMatchObject({ type: 'ready' })
    ctx.emit('api-session/directories-changed', 'ungranted-session' as typeof agent.id)
    ctx.emit('api-session/directories-changed', agent.id)
    expect((await stream.next()).value).toEqual({ type: 'emit', event: 'api-session/directories-changed', args: [agent.id] })
    // An allowed sentinel proves that the first denied frame was consumed, not merely delayed.
  } finally { controller.abort(); await stream.return?.(); await peer.dispose() }
})
