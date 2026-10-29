/** Real launchers enter the Next bootstrap and shared CLI; only the final CLI payload is synthetic. */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { expect, it, onTestFinished } from 'vitest'
import { prepareDesktopCli } from '../scripts/prepare-cli.ts'
import { NEXT_DESKTOP_IDENTITY } from '../src/next-distribution.ts'

async function fixture(distribution: 'official' | 'next' = 'next') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-next-cli-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const platform = process.platform === 'win32' ? 'win32' : 'darwin'
  const application = join(root, 'Next 中文 with spaces.app')
  const resources = join(application, ...platform === 'win32' ? ['resources'] : ['Contents', 'Resources'])
  const archive = join(resources, 'app.asar')
  const bootstrap = join(archive, 'lib')
  const runtime = join(archive, 'dsh')
  const host = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib')
  const cli = join(resources, 'runtime', 'cli')
  const home = join(root, 'home')
  const upstream = join(root, 'official-custom')
  await Promise.all([bootstrap, host, home, upstream].map(path => mkdir(path, { recursive: true })))
  const manifest = {
    type: 'module', name: NEXT_DESKTOP_IDENTITY.packageName, productName: NEXT_DESKTOP_IDENTITY.productName,
    dshDesktopAppId: NEXT_DESKTOP_IDENTITY.appId, dshDesktopUpdateChannel: 'latest',
    dshNext: { schemaVersion: 1, repository: NEXT_DESKTOP_IDENTITY.repository,
      repositoryId: NEXT_DESKTOP_IDENTITY.repositoryId, updateMode: 'manual' },
  }
  await writeFile(join(archive, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(host, 'package.json'), '{"type":"module"}\n')
  // Erase actual TypeScript and resolve its package imports locally. This fixture does not verify tsdown or ASAR packing.
  async function emit(source: string, destination: string, imports: Record<string, string> = {}) {
    let code = ts.transpileModule(await readFile(new URL(source, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024, rewriteRelativeImportExtensions: true },
    }).outputText
    for (const [original, replacement] of Object.entries(imports)) code = code.replaceAll(original, replacement)
    await writeFile(destination, code)
  }
  await emit('../src/next-cli-entry.ts', join(bootstrap, 'next-cli-entry.js'))
  await emit('../src/next-distribution.ts', join(bootstrap, 'next-distribution.js'))
  await emit('../src/next-profile.ts', join(bootstrap, 'next-profile.js'), { '@deepseek-ai/dsh-home-paths': './home-paths.js' })
  await emit('../../../packages/util/home-paths/src/index.ts', join(bootstrap, 'home-paths.js'))
  await emit('../../desktop-host/src/cli.ts', join(host, 'cli.js'), { '@deepseek-ai/dsh/lib/bin.js': './payload.js' })
  await writeFile(join(host, 'office-engine.js'), 'export function installOfficeEngineResolution() {}\nexport function runtimeArchivePath(runtime) { return runtime.slice(0, -4) }\n')
  await writeFile(join(host, 'windows-cli-signals.js'), "export async function installWindowsCliSignals() { process.env.DSH_CLI_FIXTURE_SIGNALS = 'installed' }\n")
  await writeFile(join(host, 'payload.js'), [
    "import { writeFile } from 'node:fs/promises'",
    'let calls = 0',
    'export async function runCli(options) {',
    "  await writeFile(process.env.DSH_CLI_FIXTURE_MARKER, 'dispatched')",
    "  if (process.argv.includes('--fixture-throw')) throw new Error('synthetic CLI failure')",
    '  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)',
    "  process.stdout.write(JSON.stringify({ calls: ++calls, args: process.argv.slice(2), cwd: process.cwd(), home: process.env.DSH_HOME, upstream: process.env.DSH_NEXT_UPSTREAM_HOME, nodeMode: process.env.ELECTRON_RUN_AS_NODE, input: Buffer.concat(chunks).toString('hex'), signals: process.env.DSH_CLI_FIXTURE_SIGNALS, manager: options.packageManager.args }) + '\\n')",
    "  process.stderr.write('separate stderr\\n')",
    '  process.exitCode = 23',
    '}', '',
  ].join('\n'))
  prepareDesktopCli(cli, platform, distribution)
  const product = distribution === 'next' ? 'DSH Next' : 'DeepSeek Harness'
  const commandName = distribution === 'next' ? 'dsh-next' : 'dsh'
  const electron = join(application, ...platform === 'win32' ? [`${product}.exe`] : ['Contents', 'MacOS', product])
  await mkdir(dirname(electron), { recursive: true })
  if (platform === 'win32') await copyFile(process.execPath, electron)
  else await symlink(process.execPath, electron)
  const command = join(cli, 'bin', platform === 'win32' ? `${commandName}.cmd` : commandName)
  const marker = join(root, 'dispatch-marker')
  async function run(overrides: NodeJS.ProcessEnv = {}, args: string[] = ['--version'], input = Buffer.alloc(0)) {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/KEY|SECRET|TOKEN|PASSWORD|^DSH_|^NODE_OPTIONS$|^NODE_PATH$/iu.test(key))),
    HOME: home, USERPROFILE: home, DSH_HOME: upstream, DSH_CLI_FIXTURE_MARKER: marker, ...overrides }
    const child = platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${command}" ${args.map(value => `"${value}"`).join(' ')}"`],
        { cwd: root, env, stdio: 'pipe', windowsVerbatimArguments: true })
      : spawn(command, args, { cwd: root, env, stdio: 'pipe' })
    const closed = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
    })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdin.end(input)
    return { code: await closed, stdout, stderr }
  }
  return { root, home, upstream, resources, archive, cli, marker, manifest, run }
}

it('prepares only dsh-next.cmd for Next while keeping the official launcher unchanged', async () => {
  const f = await fixture()
  const next = join(f.root, 'windows-next')
  const official = join(f.root, 'windows-official')
  prepareDesktopCli(next, 'win32', 'next')
  prepareDesktopCli(official, 'win32')
  const command = await readFile(join(next, 'bin', 'dsh-next.cmd'), 'utf8')
  expect(command).toContain('DSH Next.exe')
  expect(command).toContain('app.asar\\lib\\next-cli-entry.js')
  await expect(readFile(join(next, 'bin', 'dsh.cmd'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(official, 'bin', 'dsh.cmd'), 'utf8')).toBe(await readFile(new URL('../cli/dsh.cmd', import.meta.url), 'utf8'))
})

it('dispatches once through the actual bootstrap and shared entry with separate home and terminal streams', async () => {
  const f = await fixture()
  const args = ['--profile', 'desktop', 'hello world', '中文 🚀', '']
  const input = Buffer.from([0, 1, 10, 255])
  const result = await f.run({}, args, input)
  expect(result.code, result.stderr).toBe(23)
  expect(JSON.parse(result.stdout)).toEqual({
    calls: 1, args, cwd: f.root, home: join(f.home, '.dsh-next'), upstream: f.upstream,
    nodeMode: '1', input: input.toString('hex'),
    ...process.platform === 'win32' ? { signals: 'installed' } : {},
    manager: ['--expose-internals', join(f.resources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
  })
  expect(result.stderr).toBe('separate stderr\n')
})

it('keeps nested Next CLI invocations isolated while retaining the original upstream root', async () => {
  const f = await fixture()
  const home = join(f.root, 'next-data')
  const result = await f.run({ DSH_NEXT_HOME: home, DSH_HOME: home, DSH_NEXT_ACTIVE_HOME: home, DSH_NEXT_UPSTREAM_HOME: f.upstream })
  expect(result.code, result.stderr).toBe(23)
  expect(JSON.parse(result.stdout)).toMatchObject({ calls: 1, home, upstream: f.upstream })
})

it.each(['unmarked', 'wrong-repository', 'upstream-root', 'upstream-alias'] as const)('rejects %s before dispatching the shared CLI', async (scenario) => {
  const f = await fixture()
  const env: NodeJS.ProcessEnv = {}
  if (scenario === 'unmarked') await writeFile(join(f.archive, 'package.json'), '{"type":"module"}')
  if (scenario === 'wrong-repository') await writeFile(join(f.archive, 'package.json'), JSON.stringify({ ...f.manifest, dshNext: { ...f.manifest.dshNext, repositoryId: 1 } }))
  if (scenario === 'upstream-root') env.DSH_NEXT_HOME = f.upstream
  if (scenario === 'upstream-alias') {
    env.DSH_NEXT_HOME = join(f.root, 'upstream-alias')
    await symlink(f.upstream, env.DSH_NEXT_HOME, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const result = await f.run(env)
  expect(result.code).not.toBe(0)
  expect(result.code).not.toBe(23)
  expect(result.stdout).toBe('')
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('propagates a shared CLI failure instead of reporting successful bootstrap completion', async () => {
  const f = await fixture()
  const result = await f.run({}, ['--fixture-throw'])
  expect(result.code).not.toBe(0)
  expect(result.code).not.toBe(23)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('synthetic CLI failure')
  expect(await readFile(f.marker, 'utf8')).toBe('dispatched')
})

it('preserves the official launcher entry and inherited home without Next mapping', async () => {
  const f = await fixture('official')
  const result = await f.run({ DSH_NEXT_HOME: join(f.root, 'ignored-next-home') })
  expect(result.code, result.stderr).toBe(23)
  const observed = JSON.parse(result.stdout) as { calls: number; home: string; upstream?: string }
  expect(observed).toMatchObject({ calls: 1, home: f.upstream })
  expect(observed.upstream).toBeUndefined()
})
