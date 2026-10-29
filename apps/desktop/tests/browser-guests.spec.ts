/** Sidebar browser guests keep one persistent partition per workspace identity. */
import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ fromPartition: vi.fn(), isPackaged: false }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return electronState.isPackaged } },
  session: { fromPartition: electronState.fromPartition },
}))

const { DesktopBrowserGuests, persistentPartition } = await import('../src/browser-guests.ts')

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

/** A session stub with every handler the guest policy installs. */
function sessionStub() {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  }
}

function guests() {
  electronState.fromPartition.mockImplementation(() => sessionStub())
  return new DesktopBrowserGuests(() => 'http://127.0.0.1:1234/')
}

it('names the partition from the workspace identity, not a random value', () => {
  expect(persistentPartition('cwd:D:\\work\\one')).toBe(persistentPartition('cwd:D:\\work\\one'))
  expect(persistentPartition('cwd:D:\\work\\one')).not.toBe(persistentPartition('cwd:D:\\work\\two'))
  // `persist:` is what makes Electron write the jar to disk at all.
  expect(persistentPartition('cwd:D:\\work\\one').startsWith('persist:')).toBe(true)
})

it('hashes the identity so a path never becomes a directory name', () => {
  const identity = 'cwd:C:\\Users\\some one\\my:project?<>|'
  const name = persistentPartition(identity)
  expect(name).toContain(createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32))
  expect(name).not.toContain('\\')
  expect(name).not.toContain(':'.repeat(2))
  expect(name).not.toContain('?')
  expect(name).not.toContain('|')
  // Only the `persist:` prefix may introduce a colon.
  expect(name.indexOf(':')).toBe('persist:'.length - 1)
})

it('reuses one partition per workspace across acquisitions', () => {
  const browser = guests()
  const owner = {} as WebContents
  const first = browser.acquire(owner, 'cwd:D:\\work\\one')
  const second = browser.acquire(owner, 'cwd:D:\\work\\one')
  expect(second.partition).toBe(first.partition)
  // A distinct workspace identity still gets its own jar.
  const other = browser.acquire(owner, 'cwd:D:\\work\\two')
  expect(other.partition).not.toBe(first.partition)
  expect(electronState.fromPartition).toHaveBeenCalledTimes(2)
})

it('keeps two identities distinct even when one is a prefix of the other', () => {
  const browser = guests()
  const owner = {} as WebContents
  const short = browser.acquire(owner, 'cwd:D:\\work')
  const long = browser.acquire(owner, 'cwd:D:\\work\\nested')
  expect(long.partition).not.toBe(short.partition)
})

it('rejects an empty or oversized workspace identity', () => {
  const browser = guests()
  const owner = {} as WebContents
  expect(() => browser.acquire(owner, '')).toThrow(/storage identity is required/)
  expect(() => browser.acquire(owner, undefined)).toThrow(/storage identity is required/)
  expect(() => browser.acquire(owner, 'x'.repeat(4097))).toThrow(/storage identity is required/)
})
