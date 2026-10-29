import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const [source, output] = process.argv.slice(2)
const root = resolve(source)
const examples = ['apps/desktop/.env.windows.example', 'apps/desktop/config/windows-packaging/production.env.example']
const identities = examples.map(path => {
  const matches = [...readFileSync(join(root, path), 'utf8').matchAll(/^DSH_DESKTOP_APP_ID=([A-Za-z0-9.-]+)\r?$/gmu)]
  assert.equal(matches.length, 1, 'The public Windows identity example must be unambiguous')
  return matches[0][1]
})
assert.equal(identities[0], identities[1])
assert.equal(identities[0], 'com.deepseek.dsh')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const builder = require.resolve('app-builder-lib/package.json')
assert.equal(JSON.parse(readFileSync(builder)).version, '26.17.0')
// Match the production Windows installer adapter: the entry initializes mutually dependent
// platform classes before their leaf module is loaded. This constructs no Target or packager.
require('app-builder-lib')
const candidates = ['out/targets/nsis/NsisTarget.js', 'out/targets/win/nsis/NsisTarget.js']
  .map(path => join(dirname(builder), path)).filter(existsSync)
assert.equal(candidates.length, 1, 'The locked NSIS implementation must resolve unambiguously')
const { NsisTarget } = require(candidates[0])
const getter = Object.getOwnPropertyDescriptor(NsisTarget.prototype, 'appGuid')?.get
assert.equal(typeof getter, 'function', 'Locked builder GUID accessor unavailable; stop before any installer')
// Invoke only the locked pure accessor. No Target, packager, official app or installer is constructed.
const guid = getter.call({ options: {}, packager: { appInfo: { id: identities[0] } } })
assert.match(guid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
assert.notEqual(guid.toLowerCase(), 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a')
writeFileSync(output, JSON.stringify({ appId: identities[0], guid: guid.toLowerCase(), builderVersion: '26.17.0',
  source: process.env.EXPECTED_PRODUCT_SHA, examples,
  nsisModuleSha256: createHash('sha256').update(readFileSync(candidates[0])).digest('hex'),
  scope: 'Synthetic state for the public upstream-source Windows identity, not an unknown existing user installation' }, null, 2) + '\n')
