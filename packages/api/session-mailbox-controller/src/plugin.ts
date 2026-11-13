/** Profile-mounted Host lifetime: private storage stays locked until all accepted operations drain. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { withHostMailbox, type HostMailboxConfig } from '@deepseek-ai/dsh-session-mailbox/host'
import { SessionMailboxController } from './index.ts'

/** Trusted profile construction, never a Remote request body. */
export const Config: z<HostMailboxConfig> = z.object({
  privateRoot: z.string().required(),
  lockWaitMs: z.natural().default(0),
  maxRecords: z.natural().min(1).default(1000),
  maxRecordBytes: z.natural().min(1).default(20_000),
  selectionTtlMs: z.natural().min(1).max(30_000).default(30_000),
})

/** Host-provided authority and read-only Session lifecycle services. */
export const inject = ['connection', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'remoteAccess']

/** Publish the Remote service only after obtaining private storage ownership. */
export async function apply(ctx: Context, config: HostMailboxConfig): Promise<void> {
  const ready = Promise.withResolvers<undefined>()
  const stop = Promise.withResolvers<undefined>()
  const lifetime = withHostMailbox(ctx, config, async (adapter) => {
    const controller = ctx.plugin(SessionMailboxController, adapter)
    try {
      await controller.await()
      ready.resolve(undefined)
      await stop.promise
    } finally { await controller.dispose() }
  })
  void lifetime.catch(ready.reject)
  ctx.effect(() => async () => { stop.resolve(undefined); await lifetime }, 'session-mailbox-controller: storage ownership')
  await ready.promise
}
