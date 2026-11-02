// @vitest-environment jsdom
/** Session picker registration and late-result isolation, without a Desktop runtime. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { StaticRemoteAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)
const HOLES = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const
async function bench(allows: (action: string) => boolean = () => true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  new StaticRemoteAccess(ctx, allows)
  const pickDirectory = vi.fn(async (): Promise<string | null> => '/fixture/picked')
  ctx.provide('uiWorkspace', { pickDirectory } as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, pickDirectory }
}

it('independently fills the session directory chooser without either Workspace hole', async () => {
  const b = await bench()
  const declaration = b.slots.register({ name: 'root', children: {
    'session.directories.directoryFlow': { kind: 'single', scope: 'root' },
  } }, () => null)
  const fiber = b.ctx.plugin({ inject: [...inject], apply })
  try {
    await fiber.await()
    expect(b.slots.entries('session.directories.directoryFlow')).toHaveLength(1)
    for (const hole of HOLES) expect(b.slots.entries(hole)).toHaveLength(0)
    await fiber.dispose()
    expect(b.slots.entries('session.directories.directoryFlow')).toHaveLength(0)
  } finally { declaration(); await b.ctx.fiber.dispose() }
})


it('does not expose the session chooser when the actual picker action is denied', async () => {
  const b = await bench(() => false)
  b.slots.register({ name: 'root', children: {
    'session.directories.directoryFlow': { kind: 'single', scope: 'root' },
  } }, () => null)
  try {
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('session.directories.directoryFlow')).toHaveLength(0)
    expect(b.pickDirectory).not.toHaveBeenCalled()
  } finally { await b.ctx.fiber.dispose() }
})
