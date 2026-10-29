import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { assertNoPeOverrides } from './windows-pe-identity.mjs'

export const configurationSourceFiles = {
  "apps/desktop/electron-builder.config.mjs": "8e46b330a71d49b44409dcf4f2eeed3f16da2ee2d82e8299aa6dcd193ee990ed",
  "apps/desktop/scripts/package-target.ts": "39017805173f4884f6cdcb430949681fd8ccd7e3ffa216bd7edaa287eaf0de39",
  "apps/desktop/scripts/electron-builder-config.mjs": "b5faf4e1329f637fca6d25bd8e91546edc9db416bb6a02d5a9c66fbc266ddbc4",
  "apps/desktop/scripts/next-package-environment.mjs": "703bf4c669361ea78ff611163dd1ae13d492982ff4fdbf4c67ceeb467f019043",
  "apps/desktop/scripts/desktop-build-commit.mjs": "6de20f78a614f15588b1888dc710ca29ba9269257696a9f8def5b72d7b15d36b",
  "apps/desktop/scripts/desktop-build-version.mjs": "954d3be414c73b2b2dba642d64d3485c72108e15bf22041d602f49a893483d82",
  "apps/desktop/scripts/desktop-build-paths.mjs": "7b1ba5b34c669edff20a1534f77166c3a1d5e4e6bf3ec97e3ab8811db54f7c67",
  "apps/desktop/scripts/macos-package-settings.mjs": "3b05bb8e6ddce62449f46503c1d13163e6ee491a7df2de7b3cee72e566367339",
  "apps/desktop/scripts/windows-package-settings.mjs": "1ea245764856e30b1fafad20275f7fde61cc08beb27f96df3163109f5add941c"
}

export const configurationBuilderFiles = {
  "out/packager.js": "420d958bc3db4c603a79acbd28b22b8de5ed480c2ceabf88d9cccf9ce0fc6e76",
  "out/util/config/config.js": "d2edce3e690c3bee805a8431d8256770d4f8c6dd7a3ea88ee28303101c4fe79f",
  "out/util/config/load.js": "e30df034da58442d06115c812cab2728a590ea172a7db1484e8801d9316e9bab"
}

/** Verify the real production entry/factory and locked normalization implementation before evaluating them. */
export function assertConfigurationFiles(files, expected) {
  for (const [path, digest] of Object.entries(expected)) {
    assert(files[path], 'Missing configuration implementation: ' + path)
    assert.equal(createHash('sha256').update(files[path]).digest('hex'), digest, 'Changed configuration implementation: ' + path)
  }
}

/** Check only explicit Next unsigned identity settings, never serialize functions or arbitrary configuration values. */
export function assertConfiguration(configuration, expected, environment, metadata) {
  assert(configuration && typeof configuration === 'object' && !Array.isArray(configuration), 'Configuration object is required')
  assertNoPeOverrides(environment, configuration, metadata)
  assert.equal(configuration.appId, 'io.github.xue-ding-e.dsh-next')
  assert.equal(configuration.productName, 'DSH Next')
  assert.equal(configuration.artifactName, 'dsh-next-${version}-${os}-${arch}-unsigned.${ext}')
  assert.deepEqual(configuration.protocols, [{ name: 'DSH Next', schemes: ['dsh-next'] }])
  assert.equal(configuration.publish, null, 'Next unsigned mode must not configure publication')
  assert.equal(configuration.forceCodeSigning, undefined)
  assert.equal(configuration.cscLink, undefined)
  assert.equal(configuration.cscKeyPassword, undefined)
  assert.equal(configuration.win?.forceCodeSigning, false)
  assert.deepEqual(configuration.win?.target, ['nsis'])
  assert.equal(configuration.win?.signtoolOptions?.sign, undefined)
  assert.equal(configuration.win?.signtoolOptions?.publisherName, undefined)
  assert.equal(configuration.nsis?.guid, 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a')
  assert.equal(configuration.nsis?.oneClick, false)
  assert.equal(configuration.nsis?.perMachine, false)
  assert.equal(configuration.nsis?.allowElevation, false)
  const extra = configuration.extraMetadata
  assert.equal(extra?.version, expected.version)
  assert.equal(extra?.name, 'dsh-next-desktop')
  assert.equal(extra?.productName, 'DSH Next')
  assert.equal(extra?.dshDesktopAppId, configuration.appId)
  assert.equal(extra?.dshBuildCommit, expected.source)
  assert.equal(extra?.dshBuildDirty, false)
  assert.equal(extra?.dshDesktopUpdateChannel, 'nightly')
  assert.equal(extra?.dshMandatoryUpdatePolicy, undefined)
  assert.deepEqual(extra?.dshNext, { schemaVersion: 1, repository: 'xue-ding-e/DSH-Next', repositoryId: 1437727533, updateMode: 'manual' })
  assert.equal(resolve(expected.applicationRoot, configuration.directories?.output), expected.outputDirectory)
  return {
    appId: configuration.appId, productName: configuration.productName, artifactName: configuration.artifactName,
    protocols: configuration.protocols, publish: null, directories: { output: configuration.directories.output },
    win: { forceCodeSigning: false, target: ['nsis'] },
    nsis: { guid: configuration.nsis.guid, oneClick: false, perMachine: false, allowElevation: false },
    extraMetadata: { version: extra.version, name: extra.name, productName: extra.productName,
      dshDesktopAppId: extra.dshDesktopAppId, dshBuildCommit: extra.dshBuildCommit, dshBuildDirty: false,
      dshDesktopUpdateChannel: extra.dshDesktopUpdateChannel, dshNext: extra.dshNext },
  }
}

async function main() {
  const [product, version, output] = process.argv.slice(2)
  assert.equal(process.platform, 'win32')
  assert.equal(process.arch, 'x64')
  assert(!process.env.DEBUG, 'Broad builder debug changes build behavior and is not configuration evidence')
  const m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)))
  assert([m.version, m.upgradeVersion].includes(version), 'Unreviewed configuration version')
  assert.match(process.env.EXPECTED_CONTROL_SHA ?? '', /^[a-f0-9]{40}$/u)
  const control = process.env.EXPECTED_CONTROL_SHA
  const root = resolve(product), app = join(root, 'apps/desktop')
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(git(['rev-parse', 'HEAD']), m.source)
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), m.tree)
  assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '')
  assertConfigurationFiles(Object.fromEntries(Object.keys(configurationSourceFiles).map(path => [path, readFileSync(join(root, path))])), configurationSourceFiles)
  const require = createRequire(join(app, 'package.json'))
  const builder = dirname(require.resolve('app-builder-lib/package.json'))
  assert.equal(JSON.parse(readFileSync(join(builder, 'package.json'))).version, '26.17.0')
  assertConfigurationFiles(Object.fromEntries(Object.keys(configurationBuilderFiles).map(path => [path, readFileSync(join(builder, path))])), configurationBuilderFiles)
  const load = name => import(pathToFileURL(join(app, 'scripts', name)).href)
  const target = await load('package-target.ts')
  const next = await load('next-package-environment.mjs')
  const commit = await load('desktop-build-commit.mjs')
  const buildVersion = await load('desktop-build-version.mjs')
  const macSettings = await load('macos-package-settings.mjs')
  const windowsSettings = await load('windows-package-settings.mjs')
  const paths = await load('desktop-build-paths.mjs')
  const invocationArguments = ['win-x64', '--next', '--unsigned', '--build-version', version]
  const invocation = target.parseDesktopPackageInvocation(invocationArguments, process.platform, process.arch)
  assert.equal(invocation.next, true); assert.equal(invocation.unsigned, true)
  assert.equal(invocation.requestedBuildVersion, version)
  assert.equal(invocation.directory, false); assert.equal(invocation.prepareOnly, false)
  assert.equal(invocation.skipNotarization, false); assert.equal(invocation.check, false)
  const packaged = commit.readDesktopBuildCommit(root)
  assert.deepEqual(packaged, { commit: m.source, dirty: false })
  const environment = next.nextDesktopPackageEnvironment({ ...process.env, GITHUB_SHA: m.source })
  environment[buildVersion.DESKTOP_BUILD_VERSION_ENV] = version
  Object.assign(environment, commit.desktopBuildCommitEnvironment(packaged))
  // These are the same exported transforms and target assignments in packageTarget(), not a default env.
  const buildEnvironment = target.withoutWindowsSigningEnvironment(target.withoutDesktopUploadCredentials(target.desktopElectronBuilderEnvironment(environment, true)))
  const targetEnvironment = { ...buildEnvironment, DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '0', DSH_DESKTOP_TARGET_PLATFORM: invocation.target.platform, DSH_DESKTOP_TARGET_ARCH: invocation.target.arch }
  const builderEnvironment = target.desktopElectronBuilderEnvironment(macSettings.macOSDownloadEnvironment(targetEnvironment, undefined), true)
  builderEnvironment.ELECTRON_BUILDER_COMPRESSION_LEVEL = String(windowsSettings.resolveWindowsPackageSettings(environment).compressionLevel)
  const builderArguments = target.desktopElectronBuilderArguments(invocation.target, false)
  assert.deepEqual(builderArguments, ['exec', 'electron-builder', '--config', 'electron-builder.config.mjs', '--win', '--x64', '--publish', 'never'])
  const metadata = JSON.parse(readFileSync(join(app, 'package.json')))
  assertNoPeOverrides(process.env, {}, metadata)
  const expectedOutput = paths.desktopArtifactOutput(paths.desktopTargetBuildPaths(invocation.target.name, environment), invocation).directory
  // No package/build hooks or artifact subprocesses are invoked by this evaluation.
  // Restore neither CI nor TTY: the normalizer loads the original production factory under these inputs.
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, builderEnvironment)
  process.chdir(app)
  require('app-builder-lib') // Initialize the package before its mutually dependent configuration leaves.
  const { getConfig } = require(join(builder, 'out/util/config/config.js'))
  const configuration = await getConfig(app, join(app, 'electron-builder.config.mjs'), undefined)
  const selected = assertConfiguration(configuration, { version, source: m.source, applicationRoot: app, outputDirectory: resolve(app, expectedOutput) }, builderEnvironment, metadata)
  assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '')
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, evidenceKind: 'normalized-production-configuration-evaluation',
    actualBuildConfigCaptured: false, hooksExecuted: false, source: m.source, tree: m.tree, control, version,
    repositoryId: 1437727533, invocationArguments, builderArguments, target: 'win-x64', next: true, unsigned: true,
    sourceFileSha256: configurationSourceFiles, builderVersion: '26.17.0', builderModuleSha256: configurationBuilderFiles,
    configuration: selected,
    scope: 'Original production exports and locked getConfig under the same sealed arguments; not a capture from the packaging process. Actual PE/ASAR/installed identity remains an independent gate.' }, null, 2) + '\n')
}
if (import.meta.main) await main()
