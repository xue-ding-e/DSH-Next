/** Directory resource invalidation never publishes late authority or revives old calls. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRootsState } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryCommands, directoryAddress } from '../src/client/directories.ts'

const sessionId = 'directory-resource' as SessionId
const facts: SessionRootsState = {
  sessionId, primaryPath: '/fixture/main', roots: [], rootsRevision: 1,
  mode: 'workspace-write', deploymentWritableRoots: [], confirmedRoots: [],
  activeWritableRoots: [], writeSupported: true, lifetime: 'live-agent',
}
const unused = async (): Promise<never> => { throw new Error('Unexpected command') }

function fixture(roots: ConstructorParameters<typeof DirectoryCommands>[0]['roots']) {
  return new DirectoryCommands({ roots, replaceRoots: unused, prepareRoots: unused, confirmRoots: unused, cancelRoots: unused })
}

describe('directory resources', () => {
  it('aborts invalidated reads and discards a late response before reading current facts', async () => {
    const entered = Promise.withResolvers<undefined>()
    const delayed = Promise.withResolvers<RemoteResult<SessionRootsState>>()
    let oldSignal: AbortSignal | undefined
    let calls = 0
    const commands = fixture(async (_request, signal) => {
      if (++calls === 1) { oldSignal = signal; entered.resolve(undefined); return delayed.promise }
      return { ok: true, value: facts }
    })
    const controller = new AbortController()
    const stream = commands.provider.open(directoryAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
    const next = stream.next()
    try {
      await entered.promise
      commands.invalidate(sessionId)
      expect(oldSignal?.aborted).toBe(true)
      delayed.resolve({ ok: true, value: { ...facts, activeWritableRoots: ['/stale'] } })
      expect((await next).value).toMatchObject({ ok: false, error: { code: 'directories/refreshing' } })
      expect((await stream.next()).value).toEqual({ ok: true, value: facts })
      expect(calls).toBe(2)
    } finally { delayed.resolve({ ok: true, value: facts }); controller.abort(); await stream.return?.(); commands.dispose() }
  })

  it('continues on reconnect after an old transport rejects on abort', async () => {
    const entered = Promise.withResolvers<undefined>()
    let calls = 0
    const commands = fixture(async (_request, signal) => {
      if (++calls > 1) return { ok: true, value: facts }
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { reject(new Error('old connection closed')) }, { once: true }))
    })
    const controller = new AbortController()
    const stream = commands.provider.open(directoryAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
    const next = stream.next()
    try {
      await entered.promise
      commands.reset()
      expect((await next).value).toMatchObject({ ok: false, error: { code: 'directories/refreshing' } })
      expect((await stream.next()).value).toEqual({ ok: true, value: facts })
    } finally { controller.abort(); await stream.return?.(); commands.dispose() }
  })

  it('shows failed transport as unavailable but can refresh again', async () => {
    let fail = true
    const commands = fixture(async () => {
      if (fail) throw new Error('offline')
      return { ok: true, value: facts }
    })
    const controller = new AbortController()
    const stream = commands.provider.open(directoryAddress(sessionId), { signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ ok: false, error: { code: 'directories/unavailable' } })
      fail = false
      commands.invalidate(sessionId)
      expect((await stream.next()).value).toMatchObject({ ok: false, error: { code: 'directories/refreshing' } })
      expect((await stream.next()).value).toEqual({ ok: true, value: facts })
    } finally { controller.abort(); await stream.return?.(); commands.dispose() }
  })

  it('rejects a late successful command after reconnect rather than accepting its receipt', async () => {
    const delayed = Promise.withResolvers<RemoteResult<void>>()
    let signal: AbortSignal | undefined
    const commands = new DirectoryCommands({ roots: unused, replaceRoots: unused, prepareRoots: unused,
      confirmRoots: async (_request, passed) => { signal = passed; await delayed.promise; return { ok: true, value: { sessionId, additionalWritableRoots: [], lifetime: 'live-agent' } } }, cancelRoots: unused })
    const confirmation = commands.confirm(sessionId, 'nonce')
    const rejected = expect(confirmation).rejects.toBeDefined()
    try {
      commands.reset()
      expect(signal?.aborted).toBe(true)
      delayed.resolve({ ok: true, value: undefined })
      await rejected
    } finally { delayed.resolve({ ok: true, value: undefined }); await confirmation.catch(() => undefined); commands.dispose() }
  })
})


it('aborts old commands on this Session lifetime change without cancelling another Session', async () => {
  const first = Promise.withResolvers<RemoteResult<void>>()
  const signals = new Map<SessionId, AbortSignal | undefined>()
  const other = 'other-session' as SessionId
  const commands = new DirectoryCommands({ roots: unused, replaceRoots: unused, prepareRoots: unused,
    confirmRoots: async (request, signal) => {
      signals.set(request.sessionId, signal)
      await first.promise
      return { ok: true, value: { sessionId: request.sessionId, additionalWritableRoots: [], lifetime: 'live-agent' } }
    }, cancelRoots: unused })
  const pending = commands.confirm(sessionId, 'old')
  const survivor = commands.confirm(other, 'other')
  const rejected = expect(pending).rejects.toBeDefined()
  try {
    commands.replaceLifetime(sessionId)
    expect(signals.get(sessionId)?.aborted).toBe(true)
    expect(signals.get(other)?.aborted).toBe(false)
    expect(commands.lifetimeOf(sessionId).getSnapshot()).toBe(1)
    expect(commands.lifetimeOf(other).getSnapshot()).toBe(0)
    first.resolve({ ok: true, value: undefined })
    await rejected
    await survivor
  } finally { first.resolve({ ok: true, value: undefined }); await Promise.allSettled([pending, survivor]); commands.dispose() }
})
