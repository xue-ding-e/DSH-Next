import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertConfiguration, assertConfigurationFiles, configurationSourceFiles, configurationBuilderFiles } from './builder-config-witness.mjs'
import { assertConfigurationWitness, buildNumberVariables } from './windows-pe-identity.mjs'

const expected = { version: '0.2.1-rc.3.20261029.1', source: 'b657266b003097bf523bf85b6051b109141f1973',
  tree: 'faca2386fef4d62baca944ccee3d002e97f58738', control: '1'.repeat(40),
  applicationRoot: resolve('synthetic-config-root/apps/desktop'), outputDirectory: resolve('synthetic-config-root/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts') }
const valid = () => ({ appId: 'io.github.xue-ding-e.dsh-next', productName: 'DSH Next',
  artifactName: 'dsh-next-${version}-${os}-${arch}-unsigned.${ext}',
  protocols: [{ name: 'DSH Next', schemes: ['dsh-next'] }], publish: null,
  directories: { output: '.desktop-build/targets/win-x64/unsigned-artifacts' },
  win: { forceCodeSigning: false, target: ['nsis'], signtoolOptions: { signingHashAlgorithms: ['sha256'] } },
  nsis: { guid: 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a', oneClick: false, perMachine: false, allowElevation: false },
  extraMetadata: { version: expected.version, name: 'dsh-next-desktop', productName: 'DSH Next',
    dshDesktopAppId: 'io.github.xue-ding-e.dsh-next', dshBuildCommit: expected.source, dshBuildDirty: false,
    dshDesktopUpdateChannel: 'nightly', dshNext: { schemaVersion: 1, repository: 'xue-ding-e/DSH-Next', repositoryId: 1437727533, updateMode: 'manual' } } })
const record = () => ({ schemaVersion: 1, evidenceKind: 'normalized-production-configuration-evaluation', actualBuildConfigCaptured: false,
  hooksExecuted: false, source: expected.source, tree: expected.tree, control: expected.control, version: expected.version,
  repositoryId: 1437727533, target: 'win-x64', next: true, unsigned: true,
  invocationArguments: ['win-x64', '--next', '--unsigned', '--build-version', expected.version],
  builderArguments: ['exec', 'electron-builder', '--config', 'electron-builder.config.mjs', '--win', '--x64', '--publish', 'never'], configuration: valid() })

test('production configuration identity produces only an explicit non-secret field selection', () => {
  const configuration = valid()
  configuration.beforeBuild = () => { throw Error('must not execute') }
  configuration.unrelatedSecretFixture = 'must not serialize'
  const selected = assertConfiguration(configuration, expected, {}, {})
  assert.equal(selected.extraMetadata.version, expected.version)
  assert.equal(selected.extraMetadata.dshBuildCommit, expected.source)
  assert.equal(selected.nsis.guid, valid().nsis.guid)
  assert.doesNotMatch(JSON.stringify(selected), /must not serialize|beforeBuild|unrelatedSecretFixture/u)
  assert.deepEqual(assertConfigurationWitness(record(), expected), valid())
})

test('wrong version, identity, publishing, unsigned settings and missing configuration are rejected', () => {
  const mutations = [
    c => { c.extraMetadata.version = '0.2.1-rc.3.20261029.2' }, c => { c.appId = 'official' },
    c => { c.productName = 'DeepSeek Harness' }, c => { c.nsis.guid = 'other-guid' },
    c => { c.publish = [{ provider: 'github' }] }, c => { c.win.forceCodeSigning = true },
    c => { c.nsis.perMachine = true }, c => { c.nsis.allowElevation = true }, c => { c.nsis.oneClick = true },
    c => { c.extraMetadata.dshBuildCommit = '2'.repeat(40) }, c => { c.extraMetadata.dshBuildDirty = true },
    c => { c.protocols[0].schemes = ['dsh'] }, c => { c.extraMetadata.dshNext.updateMode = 'automatic' },
    c => { c.directories.output = '../foreign' }, c => { delete c.extraMetadata }, c => { delete c.nsis },
    c => { delete c.win }, c => { delete c.publish }, c => { delete c.directories },
  ]
  for (const mutate of mutations) { const c = valid(); mutate(c); assert.throws(() => assertConfiguration(c, expected, {}, {})) }
  for (const missing of [undefined, null, [], {}]) assert.throws(() => assertConfiguration(missing, expected, {}, {}))
})

test('ambient and configured PE overrides fail before projection can omit them', () => {
  for (const name of buildNumberVariables) assert.throws(() => assertConfiguration(valid(), expected, { [name]: '1' }, {}))
  for (const key of ['buildVersion', 'buildNumber']) { const c = valid(); c[key] = '1'; assert.throws(() => assertConfiguration(c, expected, {}, {})) }
  for (const key of ['shortVersion', 'shortVersionWindows']) {
    const c = valid(); c.extraMetadata[key] = '1'; assert.throws(() => assertConfiguration(c, expected, {}, {}))
    assert.throws(() => assertConfiguration(valid(), expected, {}, { [key]: '1' }))
  }
})

test('witness records cannot impersonate a live snapshot, other source/version or a publishing command', () => {
  const mutations = [r => { r.actualBuildConfigCaptured = true }, r => { r.hooksExecuted = true },
    r => { r.version = '0.2.1-rc.3.20261029.2' }, r => { r.source = '2'.repeat(40) }, r => { r.control = '2'.repeat(40) },
    r => { r.tree = '2'.repeat(40) }, r => { r.unsigned = false }, r => { r.next = false }, r => { r.target = 'mac-x64' },
    r => { r.builderArguments[r.builderArguments.length - 1] = 'always' }, r => { r.invocationArguments.pop() },
    r => { delete r.configuration }, r => { delete r.evidenceKind }]
  for (const mutate of mutations) { const r = record(); mutate(r); assert.throws(() => assertConfigurationWitness(r, expected)) }
})

test('missing or changed source/config-loader bytes fail and actual production functions are used without hooks or DEBUG', () => {
  const bytes = Buffer.from('synthetic locked implementation'), files = { owner: bytes }
  const digests = { owner: createHash('sha256').update(bytes).digest('hex') }
  assertConfigurationFiles(files, digests)
  assert.throws(() => assertConfigurationFiles({}, digests))
  assert.throws(() => assertConfigurationFiles({ owner: Buffer.from('changed') }, digests))
  assert.equal(Object.keys(configurationSourceFiles).length, 9)
  assert.equal(Object.keys(configurationBuilderFiles).length, 3)
  const helper = readFileSync(new URL('./builder-config-witness.mjs', import.meta.url), 'utf8')
  for (const actual of ['parseDesktopPackageInvocation', 'nextDesktopPackageEnvironment', 'desktopBuildCommitEnvironment', 'desktopElectronBuilderEnvironment', 'macOSDownloadEnvironment', 'desktopElectronBuilderArguments', 'getConfig(app,']) assert(helper.includes(actual), actual)
  assert.match(helper, /actualBuildConfigCaptured: false/u)
  assert.match(helper, /GITHUB_SHA: m\.source/u)
  assert.doesNotMatch(helper, /\.beforeBuild\(|\.beforePack\(|\.afterPack\(|new Packager|DEBUG\s*=/u)
})
