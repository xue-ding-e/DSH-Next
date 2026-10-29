import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const namespace = '50e065bc-3134-11e6-9bab-38c9862bdaf3'
const nsisSha256 = 'fa6d32306dc6eb12d656c4c821aad691f0efa47508df100ef046364d409c521f'
const uuidSha256 = '5a58134245d8e5ae587e995195d3ca33d9f9e273fc077d700e675f4c4005c029'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export function assertUuidContract(uuidBytes) {
  assert.equal(hash(uuidBytes), uuidSha256, 'Locked UUID implementation changed')
}

export function assertBuilderContract(nsisBytes, uuidBytes) {
  assert.equal(hash(nsisBytes), nsisSha256, 'Locked NSIS GUID implementation changed')
  assertUuidContract(uuidBytes)
  const text = nsisBytes.toString('utf8')
  assert(text.includes(`const ELECTRON_BUILDER_NS_UUID = builder_util_runtime_1.UUID.parse("${namespace}");`))
  assert(text.includes('const guid = options.guid || builder_util_runtime_1.UUID.v5(appInfo.id, ELECTRON_BUILDER_NS_UUID);'))
}

export function deriveOfficialGuid(appId, selectedNamespace, UUID) {
  assert.equal(appId, 'com.deepseek.dsh')
  assert.equal(selectedNamespace, namespace)
  const guid = UUID.v5(appId, UUID.parse(selectedNamespace))
  assert.match(guid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
  assert.notEqual(guid.toLowerCase(), 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a')
  // Independently reproduced with RFC 4122 UUIDv5, not an invented random registry sentinel.
  assert.equal(guid.toLowerCase(), '1bf39983-50d0-5fe0-9ef4-cece76f67c5e')
  return guid.toLowerCase()
}

function main() {
  const [source, output] = process.argv.slice(2)
  const root = resolve(source)
  const examples = ['apps/desktop/.env.windows.example', 'apps/desktop/config/windows-packaging/production.env.example']
  const identities = examples.map(path => {
    const matches = [...readFileSync(join(root, path), 'utf8').matchAll(/^DSH_DESKTOP_APP_ID=([A-Za-z0-9.-]+)\r?$/gmu)]
    assert.equal(matches.length, 1, 'The public Windows identity example must be unambiguous')
    return matches[0][1]
  })
  assert.equal(identities[0], identities[1])
  const require = createRequire(join(root, 'apps/desktop/package.json'))
  const builder = require.resolve('app-builder-lib/package.json')
  assert.equal(JSON.parse(readFileSync(builder)).version, '26.17.0')
  const builderRequire = createRequire(builder)
  const runtime = builderRequire.resolve('builder-util-runtime/package.json')
  assert.equal(JSON.parse(readFileSync(runtime)).version, '9.7.0')
  const nsisBytes = readFileSync(join(dirname(builder), 'out/targets/nsis/NsisTarget.js'))
  const uuidPath = join(dirname(runtime), 'out/uuid.js')
  const uuidBytes = readFileSync(uuidPath)
  assertBuilderContract(nsisBytes, uuidBytes)
  // In 26.17.0 the expression is inside buildInstaller, not a prototype getter. Call only its
  // exact locked UUID helper; importing or constructing a Target/packager is unnecessary.
  const { UUID } = builderRequire(uuidPath)
  const guid = deriveOfficialGuid(identities[0], namespace, UUID)
  writeFileSync(output, JSON.stringify({ appId: identities[0], guid, builderVersion: '26.17.0',
    runtimeVersion: '9.7.0', source: process.env.EXPECTED_PRODUCT_SHA, examples,
    nsisModuleSha256: hash(nsisBytes), uuidModuleSha256: hash(uuidBytes), namespace,
    scope: 'Synthetic state for the public upstream-source Windows identity, not an unknown existing user installation' }, null, 2) + '\n')
}
if (import.meta.main) main()
