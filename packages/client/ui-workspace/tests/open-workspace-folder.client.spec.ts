import assert from 'node:assert/strict'
import { it } from 'vitest'
import { createWorkspaceFolderOpener } from '../src/client/open-workspace-folder.ts'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

const id = 'clicked' as WorkspaceId
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture(path = '/projects/中文 folder,= & $()') {
  const workspace = { workspaceId: id, path, title: 'Clicked', sessionIds: [], createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' }
  let snapshot: Pick<WorkspaceSnapshot, 'phase' | 'state' | 'items'> = { phase: 'ready', state: 'idle', items: [workspace] }
  let lifetime = new AbortController()
  const opened: string[] = []
  let failures = 0
  const remote = {
    canOpenWorkspacePath: async (): Promise<{ ok: true; value: boolean } | { ok: false }> => ({ ok: true, value: true }),
    openWorkspacePath: async (request: { path: string }, _signal: AbortSignal): Promise<{ ok: true; value: { opened: true } } | { ok: false }> => {
      opened.push(request.path)
      return { ok: true, value: { opened: true } }
    },
  }
  const open = createWorkspaceFolderOpener({ list: { getSnapshot: () => snapshot } }, remote, () => { failures++ }, () => lifetime.signal)
  return { open, remote, opened, workspace, failures: () => failures,
    dispose: () => { lifetime.abort() }, reset: () => { lifetime.abort(); lifetime = new AbortController() },
    change: (value: typeof snapshot) => { snapshot = value },
  }
}

it('opens exactly the clicked registered path without shell encoding or choosing the current session', async () => {
  const f = fixture()
  f.open(id)
  await settle()
  assert.deepEqual(f.opened, ['/projects/中文 folder,= & $()'])
  assert.equal(f.failures(), 0)
})

it('never sends an unknown workspace identity to the native opener', async () => {
  const f = fixture()
  f.open('wrong' as WorkspaceId)
  await settle()
  assert.deepEqual(f.opened, [])
  assert.equal(f.failures(), 1)
})

for (const state of ['loading', 'error'] as const) {
  it(`refuses an initially stale ready snapshot in ${state} state`, async () => {
    const f = fixture()
    f.change({ phase: 'ready', state, items: [f.workspace] })
    f.open(id)
    await settle()
    assert.deepEqual(f.opened, [])
    assert.equal(f.failures(), 1)
  })
  it(`refuses a ready snapshot that becomes ${state} during capability checking`, async () => {
    const f = fixture()
    f.remote.canOpenWorkspacePath = async () => {
      f.change({ phase: 'ready', state, items: [f.workspace] })
      return { ok: true, value: true }
    }
    f.open(id)
    await settle()
    assert.deepEqual(f.opened, [])
    assert.equal(f.failures(), 1)
  })
}

for (const change of ['deleted', 'path', 'pending'] as const) {
  it(`refuses ${change} workspace while checking the desktop`, async () => {
    const f = fixture()
    f.remote.canOpenWorkspacePath = async () => {
      f.change({ phase: change === 'pending' ? 'pending' : 'ready', state: 'idle',
        items: change === 'deleted' ? [] : [{ ...f.workspace, path: change === 'path' ? '/changed' : f.workspace.path }] })
      return { ok: true, value: true }
    }
    f.open(id)
    await settle()
    assert.deepEqual(f.opened, [])
    assert.equal(f.failures(), 1)
  })
}

for (const result of [{ ok: true as const, value: false }, { ok: false as const }]) {
  it(`reports unavailable or denied desktop capability: ${JSON.stringify(result)}`, async () => {
    const f = fixture()
    f.remote.canOpenWorkspacePath = async () => result
    f.open(id)
    await settle()
    assert.deepEqual(f.opened, [])
    assert.equal(f.failures(), 1)
  })
}

it('deduplicates in-flight clicks and permits a later retry', async () => {
  const f = fixture()
  f.open(id); f.open(id)
  await settle()
  assert.equal(f.opened.length, 1)
  f.open(id)
  await settle()
  assert.equal(f.opened.length, 2)
})

it('reports native rejection and clears pending state for retry', async () => {
  const f = fixture()
  f.remote.openWorkspacePath = async () => ({ ok: false })
  f.open(id)
  await settle()
  f.open(id)
  await settle()
  assert.equal(f.failures(), 2)
})

it('contains transport exceptions and reports failure', async () => {
  const f = fixture()
  f.remote.canOpenWorkspacePath = async () => { throw new Error('Disconnected') }
  f.open(id)
  await settle()
  assert.equal(f.failures(), 1)
  assert.deepEqual(f.opened, [])
})

for (const invalidate of ['dispose', 'reset'] as const) {
  it(`does not open or notify after ${invalidate} during capability checking`, async () => {
    const f = fixture()
    let resolve!: (value: { ok: true; value: boolean }) => void
    f.remote.canOpenWorkspacePath = () => new Promise(done => { resolve = done })
    f.open(id)
    f[invalidate]()
    resolve({ ok: true, value: true })
    await settle()
    assert.deepEqual(f.opened, [])
    assert.equal(f.failures(), 0)
  })
  it(`passes lifetime cancellation to the native request and suppresses stale feedback on ${invalidate}`, async () => {
    const f = fixture()
    let received: AbortSignal | undefined
    let finish!: (value: { ok: false }) => void
    f.remote.openWorkspacePath = (_request, signal) => {
      received = signal
      return new Promise(done => { finish = done })
    }
    f.open(id)
    await settle()
    assert.equal(received?.aborted, false)
    f[invalidate]()
    assert.equal(received?.aborted, true)
    finish({ ok: false })
    await settle()
    assert.equal(f.failures(), 0)
  })
}

it('a disposed callback cannot start a new request', async () => {
  const f = fixture()
  f.dispose()
  f.open(id)
  await settle()
  assert.deepEqual(f.opened, [])
  assert.equal(f.failures(), 0)
})

it('an old generation settling cannot clear the new generation deduplication entry', async () => {
  const f = fixture()
  const waiting: ((value: { ok: true; value: boolean }) => void)[] = []
  f.remote.canOpenWorkspacePath = () => new Promise(done => { waiting.push(done) })
  f.open(id)
  f.reset()
  f.open(id)
  assert.equal(waiting.length, 2)
  waiting[0]!({ ok: true, value: true })
  await settle()
  f.open(id)
  assert.equal(waiting.length, 2)
  waiting[1]!({ ok: true, value: true })
  await settle()
  assert.equal(f.opened.length, 1)
  assert.equal(f.failures(), 0)
})
