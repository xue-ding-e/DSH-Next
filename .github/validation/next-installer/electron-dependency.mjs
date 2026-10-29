import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const electronVersion = '44.7.0'
export const electronGetVersion = '5.1.0'
export const artifactName = 'electron-v44.7.0-win32-x64.zip'
export function dependencyVerification(wasCold) {
  return { archiveSha256IndependentlyMeasured: false, method: wasCold
    ? 'Official Electron lazy installer with bundled checksum verification; no independent archive hash recorded'
    : 'Existing installed dependency inspected and executed in Node mode; this require does not newly download or verify the ZIP' }
}
export const officialArtifactUrl = 'https://github.com/electron/electron/releases/download/v44.7.0/' + artifactName

/** Retain the installed npm package's checksum verification and official release selection. */
export function assertElectronInputs(electron, getter, checksums, environment) {
  assert.equal(electron.name, 'electron'); assert.equal(electron.version, electronVersion)
  assert.equal(getter.name, '@electron/get'); assert.equal(getter.version, electronGetVersion)
  assert.equal(getter.exports, './dist/index.js')
  assert.match(checksums[artifactName] ?? '', /^[a-f0-9]{64}$/u, 'Missing bundled Windows x64 checksum')
  const forbidden = new Set(['electron_override_dist_path', 'electron_install_platform', 'electron_install_arch',
    'npm_config_platform', 'npm_config_arch', 'npm_config_target_arch', 'force_no_cache', 'node_options', 'node_path',
    'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums', 'electron_config_cache', 'electron_get_use_proxy'])
  for (const key of Object.keys(environment)) {
    const lower = key.toLowerCase()
    assert(!forbidden.has(lower) && !/^(?:npm_config_|npm_package_config_)?electron_(?:mirror|nightly_?mirror|custom_?(?:dir|filename|version)|skip_binary_download)$/u.test(lower),
      'Unreviewed Electron dependency override: ' + key)
  }
  return checksums[artifactName]
}

/** Canonical dependency files must remain in this checkout, never an inherited override installation. */
export function assertOwnedDependencyPath(root, selected) {
  const suffix = relative(root, selected)
  assert(suffix && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix), 'Dependency escaped its owned checkout')
}

/** Inspect the downloaded vendor executable without launching a renderer or application profile. */
export function assertElectronProbe(probe) {
  assert.deepEqual({ electron: probe.electron, platform: probe.platform, arch: probe.arch, nodeMode: probe.nodeMode },
    { electron: electronVersion, platform: 'win32', arch: 'x64', nodeMode: '1' })
  assert.match(probe.node ?? '', /^\d+\.\d+\.\d+$/u)
}

/** The file must be a native AMD64 PE before it is allowed to run in Electron Node mode. */
export function assertElectronPe(header, pe) {
  assert.equal(header.toString('ascii', 0, 2), 'MZ')
  assert.equal(pe.toString('ascii', 0, 4), 'PE\0\0')
  assert.equal(pe.readUInt16LE(4), 0x8664)
}

async function main() {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const [product, output] = process.argv.slice(2)
  const root = realpathSync.native(resolve(product))
  // Resolve from the exact consumer used by the native console-signal suite.
  const require = createRequire(join(root, 'apps/desktop/tests/windows-cli-signals.spec.ts'))
  const entry = realpathSync.native(require.resolve('electron'))
  const packageRoot = dirname(entry)
  assertOwnedDependencyPath(root, entry)
  assert.equal(basename(entry), 'index.js')
  const packageRequire = createRequire(join(packageRoot, 'package.json'))
  const getEntry = realpathSync.native(packageRequire.resolve('@electron/get'))
  assertOwnedDependencyPath(root, getEntry)
  assert.equal(basename(getEntry), 'index.js'); assert.equal(basename(dirname(getEntry)), 'dist')
  // @electron/get exports only dist/index.js; resolving its package.json subpath is intentionally unsupported.
  const getter = JSON.parse(readFileSync(join(dirname(getEntry), '..', 'package.json')))
  const electron = JSON.parse(readFileSync(join(packageRoot, 'package.json')))
  const checksums = JSON.parse(readFileSync(join(packageRoot, 'checksums.json')))
  const zipSha256 = assertElectronInputs(electron, getter, checksums, process.env)
  const cache = mkdtempSync(join(realpathSync.native(process.env.RUNNER_TEMP), 'dsh-next-electron-'))
  process.env.electron_config_cache = cache
  const wasCold = !existsSync(join(packageRoot, 'path.txt')) || !existsSync(join(packageRoot, 'dist/electron.exe'))
  const started = Date.now()
  // This is Electron's own lazy installer, including bundled release checksums, not a replacement downloader.
  const executable = realpathSync.native(require('electron'))
  const requireElapsedMs = Date.now() - started
  assertOwnedDependencyPath(root, executable)
  assert.equal(executable, realpathSync.native(join(packageRoot, 'dist/electron.exe')))
  assert.equal(readFileSync(join(packageRoot, 'path.txt'), 'utf8'), 'electron.exe')
  assert.equal(readFileSync(join(packageRoot, 'dist/version'), 'utf8').replace(/^v/u, '').trim(), electronVersion)
  const fd = openSync(executable, 'r')
  try {
    const header = Buffer.alloc(64); assert.equal(readSync(fd, header, 0, 64, 0), 64)
    const offset = header.readUInt32LE(0x3c); assert(offset >= 64 && offset + 6 <= statSync(executable).size)
    const pe = Buffer.alloc(6); assert.equal(readSync(fd, pe, 0, 6, offset), 6); assertElectronPe(header, pe)
  } finally { closeSync(fd) }
  const result = spawnSync(executable, ['-e', 'process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,platform:process.platform,arch:process.arch,nodeMode:process.env.ELECTRON_RUN_AS_NODE}))'],
    { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 128 * 1024, windowsHide: true })
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const probe = JSON.parse(result.stdout); assertElectronProbe(probe)
  const digest = createHash('sha256'); for await (const bytes of createReadStream(executable)) digest.update(bytes)
  writeFileSync(output, JSON.stringify({ source: process.env.EXPECTED_PRODUCT_SHA, electronVersion, electronGetVersion,
    officialArtifactUrl, bundledZipSha256: zipSha256, executableSha256: digest.digest('hex'), wasCold, requireElapsedMs,
    probe, archiveVerification: dependencyVerification(wasCold), dependencyPrepared: true, scope: 'Official locked test dependency in Node mode; not a Next package or GUI acceptance' }, null, 2) + '\n')
}
if (import.meta.main) await main()
