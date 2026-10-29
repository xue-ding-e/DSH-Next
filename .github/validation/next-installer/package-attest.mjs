import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [application, version, source, output, expectedAsar] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert(process.versions.electron, 'inspect using the actual packaged Electron in Node mode')
assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
assert.equal(resolve(process.execPath), resolve(application, 'DSH Next.exe'))
assert.match(source, /^[a-f0-9]{40}$/u)
// Electron's patched fs reads ASAR members; original-fs streams the raw archive bytes for comparison.
const originalFs = createRequire(import.meta.url)('original-fs')
const hash = async path => {
  const digest = createHash('sha256')
  for await (const chunk of originalFs.createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
const asar = join(application, 'resources/app.asar')
const metadata = JSON.parse(readFileSync(join(asar, 'package.json')))
assert.equal(metadata.name, 'dsh-next-desktop')
assert.equal(metadata.productName, 'DSH Next')
assert.equal(metadata.dshDesktopAppId, 'io.github.xue-ding-e.dsh-next')
assert.deepEqual(metadata.dshNext, { schemaVersion: 1, repository: 'xue-ding-e/DSH-Next', repositoryId: 1437727533, updateMode: 'manual' })
assert.equal(metadata.version, version)
assert.equal(metadata.dshBuildCommit, source)
assert.equal(metadata.dshBuildDirty, false)
assert.equal(metadata.dshDesktopUpdateChannel, version.includes('-') ? 'nightly' : 'latest')
assert.equal(metadata.dshMandatoryUpdatePolicy, undefined)
assert(existsSync(join(asar, 'lib/main.js')))
assert(existsSync(join(asar, 'lib/next-cli-entry.js')))
assert(!existsSync(join(application, 'resources/app-update.yml')))
const launcher = join(application, 'resources/runtime/cli/bin/dsh-next.cmd')
assert(existsSync(launcher))
assert(!existsSync(join(dirname(launcher), 'dsh.cmd')))
assert.match(readFileSync(launcher, 'utf8'), /DSH Next\.exe/u)
assert.match(readFileSync(launcher, 'utf8'), /app\.asar\\lib\\next-cli-entry\.js/u)
const descriptor = originalFs.openSync(process.execPath, 'r')
try {
  const header = Buffer.alloc(64)
  assert.equal(originalFs.readSync(descriptor, header, 0, header.length, 0), header.length)
  assert.equal(header.toString('ascii', 0, 2), 'MZ')
  const pe = Buffer.alloc(6)
  assert.equal(originalFs.readSync(descriptor, pe, 0, pe.length, header.readUInt32LE(0x3c)), pe.length)
  assert.equal(pe.toString('ascii', 0, 4), 'PE\0\0')
  assert.equal(pe.readUInt16LE(4), 0x8664)
} finally { originalFs.closeSync(descriptor) }
const asarSha256 = await hash(asar)
if (expectedAsar !== undefined) assert.equal(asarSha256, expectedAsar, 'installed ASAR differs from this run package')
writeFileSync(output, JSON.stringify({ version, source, repositoryId: 1437727533,
  appId: metadata.dshDesktopAppId, installerGuid: 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a',
  productName: metadata.productName, packageName: metadata.name, updateMode: metadata.dshNext.updateMode,
  dirty: metadata.dshBuildDirty, asarSha256, executableSha256: await hash(process.execPath), launcherSha256: await hash(launcher),
  electron: process.versions.electron, architecture: process.arch, actualPackagedElectron: true,
  scope: 'Actual package identity and CLI bootstrap files; not GUI interaction or installed update success' }, null, 2) + '\n')
