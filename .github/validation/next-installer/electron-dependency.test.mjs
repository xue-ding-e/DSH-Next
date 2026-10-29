import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { artifactName, assertElectronInputs, assertElectronPe, assertElectronProbe, assertOwnedDependencyPath, dependencyVerification, officialArtifactUrl } from './electron-dependency.mjs'
const electron = { name: 'electron', version: '44.7.0' }
const getter = { name: '@electron/get', version: '5.1.0', exports: './dist/index.js' }
const checksums = { [artifactName]: 'a'.repeat(64) }

test('only frozen Electron/get versions and bundled official Windows x64 checksum authorize preparation', () => {
  assert.equal(assertElectronInputs(electron, getter, checksums, {}), checksums[artifactName])
  assert.equal(dependencyVerification(false).archiveSha256IndependentlyMeasured, false)
  assert.match(dependencyVerification(false).method, /does not newly download or verify the ZIP/u)
  assert.equal(dependencyVerification(true).archiveSha256IndependentlyMeasured, false)
  assert.match(dependencyVerification(true).method, /bundled checksum verification/u)
  assert.equal(officialArtifactUrl, 'https://github.com/electron/electron/releases/download/v44.7.0/electron-v44.7.0-win32-x64.zip')
  for (const values of [[{ ...electron, version: '44.7.1' }, getter, checksums], [electron, { ...getter, version: '3.1.0' }, checksums],
    [electron, { ...getter, exports: './different.js' }, checksums], [electron, getter, {}], [electron, getter, { [artifactName]: 'invalid' }]]) {
    assert.throws(() => assertElectronInputs(...values, {}))
  }
})
test('case-insensitive mirrors, custom versions, bypasses, foreign binary paths and platform overrides are rejected', () => {
  for (const key of ['ELECTRON_MIRROR', 'npm_config_electron_mirror', 'NPM_CONFIG_ELECTRON_CUSTOM_DIR',
    'npm_package_config_electron_customVersion', 'ELECTRON_CUSTOM_FILENAME', 'ELECTRON_NIGHTLY_MIRROR',
    'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'npm_config_arch',
    'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums', 'ELECTRON_SKIP_BINARY_DOWNLOAD',
    'electron_config_cache', 'NODE_OPTIONS', 'NODE_PATH', 'force_no_cache', 'ELECTRON_GET_USE_PROXY']) {
    assert.throws(() => assertElectronInputs(electron, getter, checksums, { [key]: '' }), assert.AssertionError, key)
  }
})
test('preparation cannot select an external executable or accept the wrong native Electron probe', () => {
  assertOwnedDependencyPath(resolve('/owned'), resolve('/owned/node_modules/electron/dist/electron.exe'))
  for (const path of ['/external/electron.exe', '/owned']) assert.throws(() => assertOwnedDependencyPath(resolve('/owned'), resolve(path)))
  const probe = { electron: '44.7.0', node: '24.19.0', platform: 'win32', arch: 'x64', nodeMode: '1' }
  assertElectronProbe(probe)
  for (const [key, value] of [['electron', '44.7.1'], ['platform', 'linux'], ['arch', 'arm64'], ['nodeMode', undefined]]) {
    assert.throws(() => assertElectronProbe({ ...probe, [key]: value }))
  }
})
test('non-PE or non-AMD64 bytes cannot run as the native dependency', () => {
  const header = Buffer.alloc(64); header.write('MZ'); const pe = Buffer.from([80, 69, 0, 0, 100, 134])
  assertElectronPe(header, pe)
  assert.throws(() => assertElectronPe(Buffer.alloc(64), pe))
  assert.throws(() => assertElectronPe(header, Buffer.from([80, 69, 0, 0, 76, 1])))
})
test('the owned preparation stays at 600 seconds and the Windows lane uses its existing bounded 90000ms Vitest defaults', () => {
  const driver = readFileSync(new URL('./windows-qualify.ps1', import.meta.url), 'utf8')
  assert.match(driver, /'electron-dependency\.mjs'\),\$Product,\(Join-Path \$evidence 'electron-dependency\.json'\)\) -WorkingDirectory \$Product -TimeoutSeconds 600/u)
  const workflow = readFileSync(new URL('../../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
  assert.match(workflow, /runs-on: windows-2025\n    env:[\s\S]*?DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'/u)
  assert.match(driver, /Run-Pnpm 'desktop-tests'[^\n]+1200/u)
})
