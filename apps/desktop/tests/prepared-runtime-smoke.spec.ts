import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, type ExecFileOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { smokePreparedRuntime } from '../scripts/smoke-prepared-runtime.ts'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const { payload } = vi.hoisted(() => ({
  payload: vi.fn(async (_file: string, _args: readonly string[], _options: ExecFileOptions) => ({ stdout: '' })),
}))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }), spawn: vi.fn() }
})
vi.mock('../scripts/smoke-runtime.ts', () => ({ smokeDesktopRuntime: vi.fn(async () => {}) }))

const roots: string[] = []
const hostArch = Object.getOwnPropertyDescriptor(process, 'arch')!
afterEach(() => {
  Object.defineProperty(process, 'arch', hostArch)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

it('retains payload progress and termination details when the child fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-failure-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'win32' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const failure = Object.assign(new Error('payload timed out'), {
    stdout: 'payload output\n', stderr: 'runtime payload: pty\n', killed: true, signal: 'SIGTERM',
  })
  payload.mockRejectedValueOnce(failure)
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await expect(smokePreparedRuntime(root, join(root, 'electron'), join(root, 'runtime'), descriptor)).rejects.toBe(failure)
  expect(stdout).toHaveBeenCalledWith('payload output\n')
  expect(stderr).toHaveBeenCalledWith('runtime payload: pty\n')
  expect(stderr).toHaveBeenCalledWith('runtime payload: killed=true, signal=SIGTERM\n')
  expect(smokeDesktopRuntime).not.toHaveBeenCalled()
})

it('smokes an x64 target verified on an arm64 build host without revalidating against the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-target-'))
  roots.push(root)
  const fixture = runtimeFixture(root)
  const target = { platform: 'darwin' as const, arch: 'x64' }
  writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name), target)
  Object.defineProperty(process, 'arch', { ...hostArch, value: 'arm64' })
  await expect(verifyDesktopRuntime(root, fixture.release.version, { ...target, arch: process.arch }))
    .rejects.toThrow(/incompatible/u)
  const descriptor = await verifyDesktopRuntime(root, fixture.release.version, target)
  const electron = join(root, 'target-electron')
  const resources = join(root, 'runtime')
  await smokePreparedRuntime(root, electron, resources, descriptor)
  expect(payload.mock.calls[0]![0]).toBe(electron)
  expect(payload.mock.calls[0]![1]).toEqual(expect.arrayContaining([root, resources]))
  expect(smokeDesktopRuntime).toHaveBeenCalledWith(root, electron, descriptor, expect.any(Object), resources)
  const environment = vi.mocked(smokeDesktopRuntime).mock.calls[0]![3]
  expect(existsSync(environment.NARB_NATIVE_CACHE_DIR!)).toBe(false)
})

it('disables both product telemetry layers in the temporary profile before its first Host start', async () => {
  const { smokeDesktopRuntime: runSmoke } = await vi.importActual<typeof import('../scripts/smoke-runtime.ts')>('../scripts/smoke-runtime.ts')
  const root = mkdtempSync(join(tmpdir(), 'prepared-runtime-private-'))
  roots.push(root)
  const runtime = runtimeFixture(root)
  const resources = join(root, 'runtime')
  mkdirSync(join(resources, 'primary-runtime'), { recursive: true })
  writeFileSync(join(resources, 'primary-runtime', 'runtime.json'), JSON.stringify({
    desktopVersion: runtime.release.version, platform: process.platform, arch: process.arch, python: '3.13.0', pythonPackages: {},
  }))
  let home = ''
  const installedName = 'desktop-installed-smoke-plugin'
  payload.mockImplementationOnce(async (_file, args, options) => {
    if (typeof options.cwd !== 'string') throw new Error('missing synthetic CLI home')
    home = options.cwd
    expect(args).toContain('add')
    expect(options.env?.DSH_TELEMETRY_DISABLED).toBe('1')
    cpSync(join(home, installedName), join(home, 'profiles', 'desktop', 'node_modules', installedName), { recursive: true })
    return { stdout: '' }
  }).mockImplementationOnce(async (_file, args) => {
    expect(args).toContain('remove')
    rmSync(join(home, 'profiles', 'desktop', 'node_modules', installedName), { recursive: true })
    return { stdout: '' }
  }).mockImplementationOnce(async (_file, args) => {
    expect(args[0]).toBe('-I')
    expect(args.at(-1)).toBe(home)
    for (const extension of ['docx', 'xlsx', 'pptx']) writeFileSync(join(home, `input.${extension}`), 'synthetic Office input')
    return { stdout: '' }
  })
  const inspected = new Error('stop after inspecting the first Host start')
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start')
  vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => {
    expect(start).toHaveBeenCalledOnce()
    expect(payload).toHaveBeenCalledTimes(3)
    if (typeof options?.cwd !== 'string') throw new Error('missing synthetic Host profile')
    const profile = options.cwd
    expect(profile).toBe(join(home, 'profiles', 'desktop'))
    expect(options.env?.DSH_TELEMETRY_DISABLED).toBe('1')
    const patches = loadOverlayPatches('desktop-smoke', join(profile, 'cordis.patch.yml'))
    const rows = loadOverlayPatches('desktop-smoke', fileURLToPath(new URL('../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url)))
      .flatMap(patch => patch.insert ?? [])
      .filter(row => ['webserver', 'product-analytics', 'desktop-product-telemetry'].includes(row.id ?? ''))
    expect(rows).toHaveLength(3)
    // Use the boot include's real patch algorithm, not a parallel YAML interpretation.
    const entries = composeEntries([[{ insert: rows }], patches], message => { throw new Error(message) })
    for (const id of ['product-analytics', 'desktop-product-telemetry']) {
      expect(entries.find(entry => entry.id === id)).toMatchObject({ disabled: true })
    }
    expect(entries.find(entry => entry.id === 'webserver')?.config).toEqual({ host: '127.0.0.1', port: 0 })
    expect(rows.find(entry => entry.id === 'product-analytics')?.config).toMatchObject({ enabled: true })
    throw inspected
  })
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop')
  await expect(runSmoke(root, join(root, 'electron'), runtime, { DSH_TELEMETRY_DISABLED: '1' }, resources)).rejects.toBe(inspected)
  expect(start).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledOnce()
  expect(existsSync(home)).toBe(false)
})
