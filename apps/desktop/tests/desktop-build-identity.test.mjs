/** Native config loading must preserve the installer's version through the shell and Web build inputs. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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
const commit = 'abcdef1234567'
const sourceSha = commit.padEnd(40, '0')
const workflow = load(await readFile(join(root, '.github/workflows/next-release.yml'), 'utf8'))
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
      + `const main = configs.find(config => {\n`
      + `  const entries = typeof config.entry === 'string' ? [config.entry] : Array.isArray(config.entry) ? config.entry : Object.values(config.entry ?? {});\n`
      + `  return entries.some(value => String(value).endsWith('lib/types/main.js'));\n`
      + `});\n`
      + `if (main === undefined) throw new Error('desktop identity test: main tsdown configuration is missing');\n`
      + `export default { ...main, entry: [${JSON.stringify(entry)}], outDir: ${JSON.stringify(output)}, onSuccess: undefined };\n`)
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
  const display = `${product}-abcdef1${selected.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : ''}`
  assert.deepEqual(await nativeIdentity(clientBuildProcessEnvironment(system, selected)), { version: product, display })
  assert.equal(officialClientBuildEnvironment(root, { DSH_CLIENT_COMMIT_HASH: commit }).DSH_CLIENT_BUILD_VERSION, `${product}-abcdef1`)
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

test('release asset verification checks the client version, display version and source commit', async () => {
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
      cwd: temporary, env: { ...system, NEXT_VERSION: releaseVersion, NEXT_CHANNEL: releaseChannel, NEXT_SOURCE_SHA: sourceSha },
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
    })
    const environment = { DSH_CLIENT_VERSION: releaseVersion, DSH_CLIENT_BUILD_VERSION: releaseVersion, DSH_CLIENT_COMMIT_HASH: sourceSha.slice(0, 7) }
    for (const field of Object.keys(environment)) {
      await writeFile(record, JSON.stringify({ environment: { ...environment, [field]: `${product}-abcdef1` } }))
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
  const script = workflow.jobs.windows.steps.find(step => step.name === 'Resolve release version').run
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-next-release-version-'))
  try {
    const output = join(temporary, 'output')
    const environment = join(temporary, 'environment')
    const invoke = (draftTag) => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: root, env: { ...system, GITHUB_RUN_NUMBER: '12', GITHUB_OUTPUT: output, GITHUB_ENV: environment, NEXT_DRAFT_TAG: draftTag },
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
    })
    const valuesFrom = async () => Object.fromEntries((await readFile(output, 'utf8')).trim().split(/\r?\n/u).map(line => line.split('=')))
    invoke('')
    const values = await valuesFrom()
    const prefix = desktopBuildVersionPrefix(product)
    assert.ok(values.version.startsWith(prefix), `release step emitted ${JSON.stringify(values)}; expected prefix ${prefix}`)
    assert.match(values.version.slice(prefix.length), /^\d{8}\.12$/u)
    assert.equal(values.tag, `v${values.version}`)
    assert.equal(values.channel, desktopBuildVersionChannel(values.version))
    assert.equal(await readFile(environment, 'utf8'), [
      `NEXT_VERSION=${values.version}`, `NEXT_TAG=${values.tag}`, `NEXT_CHANNEL=${values.channel}`, '',
    ].join(EOL))
    await writeFile(output, '')
    invoke(`v${releaseVersion}`)
    assert.deepEqual(await valuesFrom(), { version: releaseVersion, tag: `v${releaseVersion}`, channel: releaseChannel })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('the release selects the event or requested main commit and rejects off-main sources', async () => {
  const script = workflow.jobs.windows.steps.find(step => step.id === 'source').run
  const mock = `
$ErrorActionPreference = 'Stop'
function gh {
  $global:LASTEXITCODE = 0
  switch -Wildcard ($args[1]) {
    '*/git/ref/heads/main' { $env:TEST_MAIN; return }
    '*/compare/*' {
      if ($args[1] -cne "repos/example/fixture/compare/$env:TEST_REQUEST...$env:TEST_MAIN") { throw 'Unexpected compare direction' }
      $env:TEST_RELATION
      return
    }
    default { throw "Unexpected GH call: $args" }
  }
}
`
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-next-release-source-'))
  try {
    const other = 'b'.repeat(40)
    const output = join(temporary, 'output')
    const invoke = (request, relation) => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', mock + script], {
      cwd: temporary, env: { ...system, GITHUB_REPOSITORY: 'example/fixture', TEST_MAIN: sourceSha,
        GITHUB_SHA: sourceSha, REQUESTED_SOURCE_SHA: request, TEST_REQUEST: request, TEST_RELATION: relation, GITHUB_OUTPUT: output },
      encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
    })
    for (const request of ['', sourceSha.toUpperCase()]) {
      await writeFile(output, '')
      invoke(request, '')
      assert.equal((await readFile(output, 'utf8')).trim(), `sha=${sourceSha}`)
    }
    await writeFile(output, '')
    assert.match(invoke(other, 'ahead'), /skipped/u)
    assert.equal(await readFile(output, 'utf8'), '')
    assert.throws(() => invoke(other, 'diverged'), /outside the history of main/u)
    assert.throws(() => invoke('main', ''), /full 40-character Git commit SHA/u)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('Next release planning and publication resume one draft and skip a published or superseded source', async () => {
  const publisher = fileURLToPath(new URL('../scripts/next-github-release.ps1', import.meta.url))
  const mock = `
$ErrorActionPreference = 'Stop'
$script:published = $false
$script:uploaded = $false
function git {
  $global:LASTEXITCODE = 0
  if ($args[0] -ceq 'rev-parse') { $env:TEST_HEAD; return }
  if ($args[0] -ceq 'ls-remote') {
    if ($script:published -or $env:TEST_TAG_COMMIT) {
      $commit = $env:TEST_TAG_COMMIT ?? $env:NEXT_SOURCE_SHA
      "$commit$([char]9)$($args[2])"
    }
    return
  }
  throw "Unexpected git call: $args"
}
function gh {
  $global:LASTEXITCODE = 0
  switch ($args[0]) {
    'api' {
      if ($args[1].EndsWith('/git/ref/heads/main')) {
        if ($script:uploaded -and $env:TEST_NEW_MAIN) { $env:TEST_NEW_MAIN } else { $env:NEXT_SOURCE_SHA }
      } else {
        $env:TEST_RELEASES
      }
    }
    'release' {
      Add-Content -LiteralPath $env:TEST_CALLS -Value (ConvertTo-Json -InputObject $args -Compress)
      if ($args[1] -ceq 'upload') { $script:uploaded = $true }
      if ($args[1] -ceq 'edit') { $script:published = $true }
    }
    default { throw "Unexpected GH call: $args" }
  }
}
`
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-next-release-publish-'))
  try {
    const output = join(temporary, 'output')
    const calls = join(temporary, 'calls')
    const assets = join(temporary, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts')
    await mkdir(assets, { recursive: true })
    const filenames = [`dsh-next-${releaseVersion}-win-x64-unsigned.exe`, 'SHA256SUMS', `${releaseChannel}.yml`, 'latest.yml']
    await Promise.all(filenames.map(name => writeFile(join(assets, name), 'synthetic asset')))
    const tag = `v${releaseVersion}`
    const draft = { tag_name: tag, name: `DSH Next ${releaseVersion}`,
      draft: true, prerelease: true, target_commitish: sourceSha }
    async function invoke({ releases, publish = false, tagCommit, newMain, head = sourceSha }) {
      await Promise.all([writeFile(output, ''), writeFile(calls, '')])
      const command = mock + (publish ? '& $env:TEST_PUBLISHER -SourceSha $env:NEXT_SOURCE_SHA -Version $env:NEXT_VERSION -Channel $env:NEXT_CHANNEL'
        : '& $env:TEST_PUBLISHER -SourceSha $env:NEXT_SOURCE_SHA')
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: temporary, env: { ...system, GITHUB_REPOSITORY: 'example/fixture', GITHUB_OUTPUT: output,
          TEST_HEAD: head, TEST_PUBLISHER: publisher, TEST_CALLS: calls, TEST_RELEASES: JSON.stringify([[], releases]),
          TEST_TAG_COMMIT: tagCommit, TEST_NEW_MAIN: newMain, NEXT_SOURCE_SHA: sourceSha,
          NEXT_VERSION: releaseVersion, NEXT_CHANNEL: releaseChannel },
        encoding: 'utf8', stdio: 'pipe', timeout: 10_000, windowsHide: true,
      })
      const executed = (await readFile(calls, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
      return { output: (await readFile(output, 'utf8')).trim(), executed }
    }
    const initial = await invoke({ releases: [] })
    assert.equal(initial.output, 'build=true')
    assert.deepEqual(await invoke({ releases: [{ ...draft, draft: false }], tagCommit: sourceSha }),
      { output: '', executed: [] })
    assert.deepEqual((await invoke({ releases: [draft] })).output.split(/\r?\n/u), [`draft_tag=${tag}`, 'build=true'])

    const create = await invoke({ releases: [], publish: true })
    assert.deepEqual(create.executed.map(command => command[1]), ['create', 'upload', 'edit'])
    for (const operation of [create.executed[0], create.executed[2]]) {
      assert.equal(operation[2], tag)
      assert.equal(operation[operation.indexOf('--target') + 1], sourceSha)
      assert.match(operation[operation.indexOf('--notes') + 1], new RegExp(sourceSha, 'u'))
    }

    const resumed = await invoke({ releases: [draft], publish: true })
    assert.deepEqual(resumed.executed.map(command => command[1]), ['upload', 'edit'])
    const [upload] = resumed.executed
    assert.deepEqual(upload.slice(0, 6), ['release', 'upload', tag, '--repo', 'example/fixture', '--clobber'])
    // PowerShell expands Windows short paths when it collects the release files with Get-Item.
    assert.deepEqual(await Promise.all(upload.slice(6).map(path => realpath(path))),
      await Promise.all(filenames.map(name => realpath(join(assets, name)))))

    const other = 'b'.repeat(40)
    const superseded = await invoke({ releases: [draft], publish: true, newMain: other })
    assert.deepEqual(superseded.executed.map(command => command[1]), ['upload'])
    await assert.rejects(invoke({ releases: [{ ...draft, target_commitish: other }], publish: true }), /belongs to a different release/u)
    await assert.rejects(invoke({ releases: [draft], tagCommit: other }), /conflicts with the Next build/u)
    await assert.rejects(invoke({ releases: [], head: other }), /Expected checkout/u)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
