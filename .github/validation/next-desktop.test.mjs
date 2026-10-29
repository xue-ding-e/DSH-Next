import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { NEXT_DESKTOP_IDENTITY, nextDesktopDistribution } from '../../apps/desktop/src/next-distribution.ts'
import { nextDesktopPackageEnvironment, isNextDesktopPackage } from '../../apps/desktop/scripts/next-package-environment.mjs'
import { checkNextManualRelease, NextManualUpdateCoordinator, selectNextManualRelease } from '../../apps/desktop/src/next-manual-update.ts'

// Node-only validation uses the same workspace source as Vitest's TS paths, without requiring a
// previous library build. This is source regression evidence, not packaged-runtime qualification.
const workspaceSource = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === '@deepseek-ai/dsh-home-paths'
    ? { url: new URL('../../packages/util/home-paths/src/index.ts', import.meta.url).href, shortCircuit: true }
    : nextResolve(specifier, context)
} })
const { nextDesktopHome, resolveNextDesktopHome, nextDesktopEnvironment, nextDesktopInstallRoot }
  = await import('../../apps/desktop/src/next-profile.ts')
workspaceSource.deregister()

const repository = { id: NEXT_DESKTOP_IDENTITY.repositoryId, full_name: NEXT_DESKTOP_IDENTITY.repository, private: false }
const base = `https://github.com/${repository.full_name}`
const manifest = () => ({ productName: NEXT_DESKTOP_IDENTITY.productName, name: NEXT_DESKTOP_IDENTITY.packageName, dshDesktopAppId: NEXT_DESKTOP_IDENTITY.appId,
  dshDesktopUpdateChannel: 'nightly', dshNext: { schemaVersion: 1, repositoryId: repository.id,
    repository: repository.full_name, updateMode: 'manual' } })
const release = (version = '0.2.1-rc.3.20261029.1', platform = 'win', arch = 'x64') => {
  const tag = `next-v${version}`
  const filename = `dsh-next-${version}-${platform}-${arch}-unsigned.${platform === 'win' ? 'exe' : 'dmg'}`
  return { draft: false, prerelease: version.includes('-'), tag_name: tag, html_url: `${base}/releases/tag/${tag}`,
    assets: [{ name: filename, state: 'uploaded', size: 1234, browser_download_url: `${base}/releases/download/${tag}/${filename}` }] }
}
const select = (values) => selectNextManualRelease(values, 'nightly', '0.2.1-rc.3', 'win32', 'x64')
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })

test('Next identifiers separate installation, protocol, package user data, and Harness home', () => {
  assert.notEqual(NEXT_DESKTOP_IDENTITY.appId, 'com.deepseek.harness')
  assert.match(NEXT_DESKTOP_IDENTITY.installerGuid, /^[a-f0-9-]{36}$/u)
  assert.equal(NEXT_DESKTOP_IDENTITY.protocol, 'dsh-next')
  assert.equal(NEXT_DESKTOP_IDENTITY.packageName, 'dsh-next-desktop')
  assert.equal(nextDesktopHome('/synthetic-user'), '/synthetic-user/.dsh-next')
  assert.equal(nextDesktopHome('/synthetic-user', '/synthetic-user/restored-next'), '/synthetic-user/restored-next')
  for (const path of ['/synthetic-user/.dsh', '/synthetic-user/.dsh/profiles/desktop', '/', 'relative']) {
    assert.throws(() => nextDesktopHome('/synthetic-user', path))
  }
})

test('unmarked packages retain their existing behavior while malformed Next identity fails closed', () => {
  assert.equal(nextDesktopDistribution({ name: '@deepseek-ai/dsh-desktop' }), undefined)
  assert.deepEqual(nextDesktopDistribution(manifest()), { channel: 'nightly', updateMode: 'manual' })
  for (const change of [
    value => { delete value.dshNext },
    value => { value.productName = 'DeepSeek Harness' },
    value => { value.name = '@deepseek-ai/dsh-desktop' },
    value => { value.dshDesktopAppId = 'com.deepseek.harness' },
    value => { value.dshNext.repositoryId-- },
    value => { value.dshNext.updateMode = 'automatic' },
    value => { value.dshDesktopUpdateChannel = 'beta' },
  ]) {
    const value = manifest(); change(value); assert.throws(() => nextDesktopDistribution(value))
  }
})

test('Next manual packaging strips credentials and upstream services without changing the caller', () => {
  const source = { PATH: '/build-tools', GH_TOKEN: 'synthetic', APPLE_API_KEY: 'synthetic',
    DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'synthetic', DOWNLOAD_TEST_ORIGIN: 'https://upstream.invalid',
    DSH_DESKTOP_APP_ID: 'com.deepseek.harness', DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{}' }
  const before = { ...source }, environment = nextDesktopPackageEnvironment(source)
  assert.deepEqual(source, before)
  assert.equal(environment.PATH, source.PATH)
  for (const key of ['GH_TOKEN', 'APPLE_API_KEY', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN', 'DOWNLOAD_TEST_ORIGIN', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG']) {
    assert.equal(Object.hasOwn(environment, key), false)
  }
  assert.equal(isNextDesktopPackage(environment), true)
  assert.equal(isNextDesktopPackage({}), false)
  assert.throws(() => isNextDesktopPackage({ ...environment, DSH_DESKTOP_UNSIGNED: '0' }))
  assert.throws(() => isNextDesktopPackage({ ...environment, DSH_DESKTOP_APP_ID: 'com.deepseek.harness' }))
})

test('manual discovery chooses only newer versioned Next installers, never a downgrade', () => {
  const later = release('0.2.1-rc.3.20261030.1')
  assert.deepEqual(select([release(), later]), { kind: 'available', version: '0.2.1-rc.3.20261030.1', page: later.html_url })
  assert.deepEqual(select([release('0.2.1-rc.2')]), { kind: 'current' })
  assert.deepEqual(select([]), { kind: 'unavailable' })
  assert.deepEqual(selectNextManualRelease([release('0.2.2')], 'latest', '0.2.1', 'win32', 'x64'),
    { kind: 'available', version: '0.2.2', page: release('0.2.2').html_url })
  assert.deepEqual(select([release('0.2.2')]), { kind: 'unavailable' })
})

for (const [name, change] of [
  ['draft', value => { value.draft = true }],
  ['wrong channel', value => { value.prerelease = false }],
  ['mutable nightly alias', value => { value.tag_name = 'nightly' }],
  ['upstream tag', value => { value.tag_name = value.tag_name.replace('next-', '') }],
  ['cross-origin page', value => { value.html_url = 'https://example.com/install' }],
  ['page credentials', value => { value.html_url = value.html_url.replace('https://', 'https://credential@') }],
  ['page query', value => { value.html_url += '?redirect=other' }],
  ['cross-origin installer', value => { value.assets[0].browser_download_url = 'https://example.com/install.exe' }],
  ['HTTP installer', value => { value.assets[0].browser_download_url = value.assets[0].browser_download_url.replace('https:', 'http:') }],
  ['unuploaded installer', value => { value.assets[0].state = 'new' }],
  ['empty installer', value => { value.assets[0].size = 0 }],
  ['wrong platform', value => { value.assets[0].name = value.assets[0].name.replace('-win-', '-mac-') }],
  ['wrong architecture', value => { value.assets[0].name = value.assets[0].name.replace('-x64-', '-arm64-') }],
  ['upstream product', value => { value.assets[0].name = value.assets[0].name.replace('dsh-next-', 'deepseek-harness-') }],
]) test(`manual discovery rejects ${name}`, () => {
  const value = release(); change(value); assert.deepEqual(select([value]), { kind: 'unavailable' })
})

test('macOS selects only the requested architecture', () => {
  const value = release('0.2.2-rc.1', 'mac', 'arm64')
  assert.equal(selectNextManualRelease([value], 'nightly', '0.2.1-rc.3', 'darwin', 'arm64').kind, 'available')
  assert.deepEqual(selectNextManualRelease([value], 'nightly', '0.2.1-rc.3', 'darwin', 'x64'), { kind: 'unavailable' })
})

test('release requests use public API endpoints with no credentials or redirects', async () => {
  const calls = []
  const request = async (url, options) => {
    calls.push([url, options]); return reply(calls.length === 1 ? repository : [release()])
  }
  assert.equal((await checkNextManualRelease('nightly', '0.2.1-rc.3', 'win32', 'x64', request)).kind, 'available')
  assert.deepEqual(calls.map(([url]) => url), [`https://api.github.com/repos/${repository.full_name}`, `https://api.github.com/repos/${repository.full_name}/releases?per_page=100`])
  for (const [, options] of calls) {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false)
  }
})

test('a recreated repository with another ID stops before reading releases', async () => {
  let calls = 0
  const result = await checkNextManualRelease('nightly', '0.2.1-rc.3', 'win32', 'x64', async () => {
    calls++; return reply({ ...repository, id: repository.id - 1 })
  })
  assert.deepEqual(result, { kind: 'error', reason: 'identity' }); assert.equal(calls, 1)
})

for (const [status, result] of [[404, { kind: 'unavailable' }], [403, { kind: 'error', reason: 'access' }], [500, { kind: 'error', reason: 'response' }]]) {
  test(`release HTTP ${status} has a bounded actionable category`, async () => {
    let calls = 0
    assert.deepEqual(await checkNextManualRelease('nightly', '0.2.1-rc.3', 'win32', 'x64', async () =>
      ++calls === 1 ? reply(repository) : reply({}, status)), result)
  })
}

test('check coalescing and disposal never start an installer or publish stale results', async () => {
  let resolveLookup, calls = 0
  const states = []
  const coordinator = new NextManualUpdateCoordinator(state => { states.push(state); return state },
    () => { calls++; return new Promise(resolve => { resolveLookup = resolve }) })
  const first = coordinator.check(), second = coordinator.check()
  assert.equal(calls, 1)
  coordinator.dispose()
  resolveLookup({ kind: 'available', version: '0.2.2', page: `${base}/releases/tag/next-v0.2.2` })
  await Promise.all([first, second]); assert.deepEqual(states, [])
  await assert.rejects(() => coordinator.check(), /disposed/u)
})


test('Next profile rejects an existing symlink into an official home before data access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-next-path-'))
  try {
    await mkdir(join(root, '.dsh'))
    await symlink(join(root, '.dsh'), join(root, '.dsh-next'), 'junction')
    await assert.rejects(() => resolveNextDesktopHome(root), /separate/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release discovery follows a later stable page instead of reporting a false empty channel', async () => {
  let calls = 0
  const api = `https://api.github.com/repos/${repository.full_name}/releases?per_page=100`
  const result = await checkNextManualRelease('latest', '0.2.1', 'win32', 'x64', async () => {
    calls++
    if (calls === 1) return reply(repository)
    if (calls === 2) return new Response(JSON.stringify([release()]), { headers: { Link: `<${api}&page=2>; rel="next"` } })
    return reply([release('0.2.2')])
  })
  assert.equal(result.kind, 'available'); assert.equal(calls, 3)
})


test('actual build version discovery increments own artifact names independently of official artifacts', async () => {
  const { suggestDesktopBuildVersion } = await import('../../apps/desktop/scripts/desktop-build-version-discovery.ts')
  const root = await mkdtemp(join(tmpdir(), 'dsh-next-version-'))
  try {
    await writeFile(join(root, 'dsh-next-0.2.1-rc.3.20261029.7-win-x64-unsigned.exe'), '')
    await writeFile(join(root, 'deepseek-harness-0.2.1-rc.3.20261029.90-win-x64.exe'), '')
    const value = await suggestDesktopBuildVersion({ productVersion: '0.2.1-rc.3', target: 'win-x64',
      environment: {}, date: '20261029', artifactsRoot: root, artifactPrefix: 'dsh-next' })
    assert.equal(value, '0.2.1-rc.3.20261029.8')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('Next data mapping protects original custom homes, installation roots and survives nested invocation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-next-environment-'))
  try {
    const upstream = join(home, 'official-custom'), root = join(home, 'next-custom'), installed = join(home, 'DSH Next')
    await mkdir(upstream); await mkdir(installed)
    const source = { DSH_HOME: upstream, DSH_NEXT_HOME: root }
    const first = await nextDesktopEnvironment(home, source, installed)
    assert.equal(source.DSH_HOME, upstream)
    assert.equal(first.DSH_HOME, root)
    assert.deepEqual(await nextDesktopEnvironment(home, first, installed), first)
    for (const configured of [upstream, join(upstream, 'nested'), home, installed, join(installed, 'profile')]) {
      await assert.rejects(() => nextDesktopEnvironment(home, { ...source, DSH_NEXT_HOME: configured }, installed), /separate/u)
    }
    assert.equal(nextDesktopInstallRoot(join(installed, 'DSH Next.exe'), 'win32'), installed)
    assert.equal(nextDesktopInstallRoot(join(installed, 'DSH Next.app', 'Contents', 'MacOS', 'DSH Next'), 'darwin'), join(installed, 'DSH Next.app'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Next canonicalizes symlink ancestors even when the final data directory is not created', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-next-ancestor-'))
  try {
    await mkdir(join(home, '.dsh'))
    await symlink(join(home, '.dsh'), join(home, 'alias'), 'junction')
    await assert.rejects(() => resolveNextDesktopHome(home, join(home, 'alias', 'not-created')), /separate/u)
    assert.equal(await resolveNextDesktopHome(home, join(home, 'legal separate home')), join(home, 'legal separate home'))
  } finally { await rm(home, { recursive: true, force: true }) }
})

for (const link of [
  'https://example.com/releases?per_page=100&page=2',
  `https://api.github.com/repos/${repository.full_name}/releases?per_page=100&page=2&other=1`,
  `https://api.github.com/repos/${repository.full_name}/releases?per_page=100&page=1`,
]) test(`release pagination refuses untrusted or looping target ${link}`, async () => {
  let calls = 0
  const result = await checkNextManualRelease('latest', '0.2.1', 'win32', 'x64', async () => {
    calls++
    return calls === 1 ? reply(repository) : new Response('[]', { headers: { Link: `<${link}>; rel="next"` } })
  })
  assert.deepEqual(result, { kind: 'error', reason: 'response' }); assert.equal(calls, 2)
})

test('a bounded incomplete release listing is not reported as current or unavailable', async () => {
  let calls = 0
  const result = await checkNextManualRelease('latest', '0.2.1', 'win32', 'x64', async () => {
    calls++
    if (calls === 1) return reply(repository)
    return new Response('[]', { headers: { Link: `<https://api.github.com/repos/${repository.full_name}/releases?per_page=100&page=${calls}>; rel="next"` } })
  })
  assert.deepEqual(result, { kind: 'error', reason: 'response' }); assert.equal(calls, 11)
})


test('unresolved Next or official link ancestors fail closed instead of becoming aliases later', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-next-dangling-'))
  try {
    await symlink(join(home, '.dsh'), join(home, '.dsh-next'), 'junction')
    await assert.rejects(() => resolveNextDesktopHome(home), /resolvable/u)
    await rm(join(home, '.dsh-next'))
    await symlink(join(home, 'not-created'), join(home, '.dsh'), 'junction')
    await assert.rejects(() => resolveNextDesktopHome(home, join(home, 'not-created')), /resolvable/u)
  } finally { await rm(home, { recursive: true, force: true }) }
})
