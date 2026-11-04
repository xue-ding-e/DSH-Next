/** Native config loading must preserve the installer's version through the shell and Web build inputs. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { EOL, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AppUpdater } from 'electron-updater/out/AppUpdater.js'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'
import { load } from 'js-yaml'
import {
  clientBuildEnvironmentDefines,
  clientBuildProcessEnvironment,
  officialClientBuildEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { nextDesktopPackageEnvironment } from '../scripts/next-package-environment.mjs'
import { desktopBuildVersionChannel, desktopBuildVersionPrefix } from '../scripts/desktop-build-version.mjs'
import { NEXT_DESKTOP_IDENTITY, nextDesktopDistribution } from '../src/next-distribution.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const product = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const releaseVersion = `${desktopBuildVersionPrefix(product)}20261104.12`
const releaseChannel = desktopBuildVersionChannel(releaseVersion)
const commit = '1813d72421df0a0675df18f219d3a28cae640da7'
const nativeConfig = new URL('../tsdown.config.ts', import.meta.url).href
const clientMetadata = new URL('../src/client-metadata.ts', import.meta.url).href
const tsdown = fileURLToPath(import.meta.resolve('tsdown/run'))
const system = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))

async function nativeIdentity(environment) {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-desktop-build-identity-'))
  try {
    const entry = join(temporary, 'identity.mjs')
    const config = join(temporary, 'tsdown.config.ts')
    const output = join(temporary, 'out')
    await writeFile(entry, `import { desktopClientVersion, desktopClientBuildVersion } from ${JSON.stringify(clientMetadata)};\n`
      + 'console.log(JSON.stringify({ version: desktopClientVersion(), display: desktopClientBuildVersion() }));\n')
    await writeFile(config, `import configs from ${JSON.stringify(nativeConfig)};\n`
      + `export default { ...configs[1], entry: [${JSON.stringify(entry)}], outDir: ${JSON.stringify(output)}, onSuccess: undefined };\n`)
    execFileSync(process.execPath, [tsdown, '--config', config, '--config-loader', 'native'], {
      cwd: root, env: { ...system, ...environment }, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true,
    })
    const [artifact] = (await readdir(output)).filter(name => /^identity\.(?:mjs|js)$/u.test(name))
    assert.ok(artifact, 'native config must emit the identity probe')
    return JSON.parse(execFileSync(process.execPath, [join(output, artifact)], {
      cwd: root, env: { ...system, DSH_CLIENT_VERSION: 'runtime-override', DSH_CLIENT_BUILD_VERSION: 'runtime-override' },
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
    }))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

test('Next release display matches its installed version and keeps its GitHub channel', async () => {
  const environment = { ...nextDesktopPackageEnvironment(system), DSH_DESKTOP_BUILD_VERSION: releaseVersion,
    DSH_CLIENT_COMMIT_HASH: commit }
  const repository = repositoryClientBuildEnvironment(root, environment)
  const selected = resolveClientBuildEnvironment(repository, 'local')
  const identity = await nativeIdentity(clientBuildProcessEnvironment(environment, selected))
  const config = createElectronBuilderConfig(environment, 'win32', 'x64')
  assert.deepEqual(identity, { version: releaseVersion, display: releaseVersion })
  assert.equal(config.extraMetadata.version, identity.display)
  assert.equal(config.appId, NEXT_DESKTOP_IDENTITY.appId)
  assert.equal(config.nsis.guid, NEXT_DESKTOP_IDENTITY.installerGuid)
  assert.equal(config.extraMetadata.dshNext.repository, NEXT_DESKTOP_IDENTITY.repository)
  assert.deepEqual(nextDesktopDistribution(config.extraMetadata), { channel: releaseChannel, updateMode: 'auto' })
  assert.deepEqual(config.publish, [{ provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next',
    releaseType: 'prerelease', channel: releaseChannel }])
  assert.equal(clientBuildEnvironmentDefines(selected)['process.env.DSH_CLIENT_BUILD_VERSION'], JSON.stringify(identity.display))
})

test('a packaged product version keeps its exact version through the official client profile', async () => {
  const environment = { DSH_DESKTOP_BUILD_VERSION: product, DSH_CLIENT_COMMIT_HASH: commit }
  const expected = officialClientBuildEnvironment(root, environment)
  const selected = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, environment), 'official')
  assert.deepEqual(selected, expected)
  assert.deepEqual(await nativeIdentity(clientBuildProcessEnvironment(environment, selected)), { version: product, display: product })
})

test('source builds keep the commit and actual dirty marker through native config loading', async () => {
  const environment = { DSH_CLIENT_COMMIT_HASH: commit, DSH_CLIENT_VERSION: 'stale', DSH_CLIENT_BUILD_VERSION: 'stale' }
  const repository = repositoryClientBuildEnvironment(root, environment)
  const selected = resolveClientBuildEnvironment(repository, 'local')
  const display = `${product}-1813d72${selected.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : ''}`
  assert.deepEqual(await nativeIdentity(clientBuildProcessEnvironment(system, selected)), { version: product, display })
  assert.equal(officialClientBuildEnvironment(root, { DSH_CLIENT_COMMIT_HASH: commit }).DSH_CLIENT_BUILD_VERSION, `${product}-1813d72`)
})

test('stable release versions and rejected release overrides use the packaging validator', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-client-release-version-'))
  try {
    await mkdir(join(temporary, 'source'))
    const fixture = join(temporary, 'source')
    await writeFile(join(fixture, 'package.json'), '{"version":"2.0.0"}\n')
    const environment = { DSH_DESKTOP_BUILD_VERSION: '2.0.0', DSH_CLIENT_COMMIT_HASH: commit }
    const selected = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(fixture, environment), 'local')
    assert.deepEqual(await nativeIdentity(clientBuildProcessEnvironment(environment, selected)), { version: '2.0.0', display: '2.0.0' })
    for (const version of ['invalid', '3.0.0', '2.0.0+ignored']) {
      const invalid = { ...environment, DSH_DESKTOP_BUILD_VERSION: version }
      assert.throws(() => repositoryClientBuildEnvironment(fixture, invalid), /desktop build version/u)
      assert.throws(() => officialClientBuildEnvironment(fixture, invalid), /desktop build version/u)
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('the real GitHub provider selects Next rc metadata and compares the complete installed version', async () => {
  const rcVersion = '0.2.1-rc.3.20261104.12'
  const base = `https://github.com/${NEXT_DESKTOP_IDENTITY.repository}/releases`
  const tag = `v${rcVersion}`
  const filename = `dsh-next-${rcVersion}-win-x64-unsigned.exe`
  const feed = `<feed>${['v9.9.9-beta.1', tag].map(value => `<entry><title>${value}</title>`
    + `<link href="${base}/tag/${value}"/><content>Release</content></entry>`).join('')}</feed>`
  const metadata = `version: ${rcVersion}\nfiles:\n  - url: ${filename}\n    sha512: ${Buffer.alloc(64).toString('base64')}\n    size: 1234\n`
  for (const [version, available] of [
    ['0.2.1-rc.3.20261104.11', true],
    [rcVersion, false],
    ['0.2.1-rc.3.20261104.13', false],
  ]) {
    // AppUpdater accepts an app adapter, so the shipping parser and comparison need no Electron process.
    const updater = new AppUpdater(undefined, { version })
    updater.channel = 'rc'
    updater.allowPrerelease = true
    updater.allowDowngrade = false
    const requests = []
    const executor = { request: async (options) => {
      const url = `${options.protocol}//${options.hostname}${options.path}`
      requests.push(url)
      if (url === `${base}.atom`) return feed
      assert.equal(url, `${base}/download/${tag}/rc.yml`)
      return metadata
    } }
    const provider = new GitHubProvider({ provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next', channel: 'rc' },
      updater, { platform: 'win32', executor, isUseMultipleRangeRequest: false })
    const info = await provider.getLatestVersion()
    assert.equal(info.version, rcVersion)
    assert.equal(info.tag, tag)
    assert.equal(await updater.isUpdateAvailable(info), available)
    assert.deepEqual(requests, [`${base}.atom`, `${base}/download/${tag}/rc.yml`])
    assert.equal(provider.resolveFiles(info)[0].url.href, `${base}/download/${tag}/${filename}`)
  }
})

test('release asset verification rejects either client version disagreeing with the published version', async () => {
  const workflow = load(await readFile(join(root, '.github/workflows/next-release.yml'), 'utf8'))
  const verify = workflow.jobs.windows.steps.find(step => step.name === 'Verify release asset').run
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-next-release-verification-'))
  try {
    const artifacts = join(temporary, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts')
    const record = join(temporary, '.dsh-build/client-build-environment.json')
    await mkdir(artifacts, { recursive: true })
    await mkdir(join(temporary, '.dsh-build'))
    // Only the workflow's metadata verifier reads these fixture bytes; they are never an executable installer.
    await writeFile(join(artifacts, `dsh-next-${releaseVersion}-win-x64-unsigned.exe`), 'synthetic artifact bytes')
    const invoke = () => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', verify], {
      cwd: temporary, env: { ...system, NEXT_VERSION: releaseVersion, NEXT_CHANNEL: releaseChannel },
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
    })
    const environment = { DSH_CLIENT_VERSION: releaseVersion, DSH_CLIENT_BUILD_VERSION: releaseVersion }
    for (const field of Object.keys(environment)) {
      await writeFile(record, JSON.stringify({ environment: { ...environment, [field]: `${product}-1813d72` } }))
      assert.throws(invoke, /Client build identity does not match release/u)
    }
    await writeFile(record, JSON.stringify({ environment }))
    invoke()
    const feed = load(await readFile(join(artifacts, `${releaseChannel}.yml`), 'utf8'))
    assert.equal(feed.version, releaseVersion)
    assert.equal(feed.files[0].url, `dsh-next-${releaseVersion}-win-x64-unsigned.exe`)
    assert.equal(await readFile(join(artifacts, 'latest.yml'), 'utf8'), await readFile(join(artifacts, `${releaseChannel}.yml`), 'utf8'))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('the native PowerShell release step emits a version, tag and matching GitHub channel', async () => {
  const workflow = load(await readFile(join(root, '.github/workflows/next-release.yml'), 'utf8'))
  const script = workflow.jobs.windows.steps.find(step => step.name === 'Resolve release version').run
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-next-release-version-'))
  try {
    const output = join(temporary, 'output')
    const environment = join(temporary, 'environment')
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: root, env: { ...system, GITHUB_RUN_NUMBER: '12', GITHUB_OUTPUT: output, GITHUB_ENV: environment },
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
    })
    const values = Object.fromEntries((await readFile(output, 'utf8')).trim().split(/\r?\n/u).map(line => line.split('=')))
    const prefix = desktopBuildVersionPrefix(product)
    assert.ok(values.version.startsWith(prefix), `release step emitted ${JSON.stringify(values)}; expected prefix ${prefix}`)
    assert.match(values.version.slice(prefix.length), /^\d{8}\.12$/u)
    assert.equal(values.tag, `v${values.version}`)
    assert.equal(values.channel, desktopBuildVersionChannel(values.version))
    assert.equal(await readFile(environment, 'utf8'), [
      `NEXT_VERSION=${values.version}`, `NEXT_TAG=${values.tag}`, `NEXT_CHANNEL=${values.channel}`, '',
    ].join(EOL))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
