import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const builderFiles = {
  'out/winPackager.js': 'ac4ae48193db71cc50be3eeb6017d4e35f934637eac0ae7ef4e0c62fbd9db552',
  'out/appInfo.js': 'd10fa4b8196933d6dd7480d107941671790062f87c81e9a7179463034779fc09',
  'out/util/resEdit.js': '02ddb3dee119c3f8aaf6a427e7fea8b2765a61778e5db6f5e02df1cbb5b16cde',
}
export const buildNumberVariables = ['BUILD_NUMBER', 'TRAVIS_BUILD_NUMBER', 'APPVEYOR_BUILD_NUMBER', 'CIRCLE_BUILD_NUM', 'BUILD_BUILDNUMBER', 'CI_PIPELINE_IID']

/** Pin the builder's version selection and resource-writing implementations without importing a packager. */
export function assertPeBuilderFiles(files) {
  for (const [path, expected] of Object.entries(builderFiles)) {
    assert(files[path], 'Missing locked PE version implementation: ' + path)
    assert.equal(createHash('sha256').update(files[path]).digest('hex'), expected, 'Changed PE version implementation: ' + path)
  }
  return { ...builderFiles }
}

/** Neither source nor actual ASAR metadata may replace the reviewed full or numeric PE version. */
export function assertNoPeMetadataOverrides(metadata) {
  for (const key of ['shortVersion', 'shortVersionWindows']) assert.equal(metadata[key], undefined, 'Unreviewed metadata override: ' + key)
}

/** Fail before packaging if inherited CI numbering could change the builder's actual version. */
export function assertNoPeOverrides(environment, configuration, metadata) {
  for (const key of buildNumberVariables) assert.equal(environment[key], undefined, 'Unreviewed build number variable: ' + key)
  for (const key of ['buildVersion', 'buildNumber']) assert.equal(configuration[key], undefined, 'Unreviewed builder override: ' + key)
  assertNoPeMetadataOverrides(metadata)
  assertNoPeMetadataOverrides(configuration.extraMetadata ?? {})
}

/** Numeric ProductVersion is distinct from the full FileVersion string restored by locked resEdit. */
export function assertPeIdentity(info, version, configuration, metadata, environment) {
  assert.match(version, /^0\.2\.1-rc\.3\.\d{8}\.[1-9]\d*$/u, 'Unreviewed package version format')
  assertNoPeOverrides(environment, configuration, metadata)
  assert.equal(configuration.extraMetadata?.version, version, 'Effective builder must package this exact full version')
  const parts = version.split('.').slice(0, 3).map(value => Number.parseInt(value, 10))
  parts.push(0) // All six ambient and both configured build-number/version overrides are forbidden above.
  assert.equal(info.ProductName, 'DSH Next')
  assert.equal(info.FileVersion, version, 'PE FileVersion must retain the complete independently built version')
  assert.equal(info.ProductVersion, parts.join('.'), 'PE ProductVersion follows the locked numeric conversion')
  for (const [index, key] of ['ProductMajorPart', 'ProductMinorPart', 'ProductBuildPart', 'ProductPrivatePart'].entries()) {
    assert.equal(info[key], parts[index], 'PE numeric resource mismatch: ' + key)
  }
  return { version, numericProductVersion: parts.join('.'), peAttested: true }
}

function main() {
  const [mode, product, versionOrOutput, report, configFile] = process.argv.slice(2)
  assert(['preflight', 'report'].includes(mode), 'Unknown PE qualification mode')
  const root = resolve(product)
  const require = createRequire(join(root, 'apps/desktop/package.json'))
  const builder = require.resolve('app-builder-lib/package.json')
  assert.equal(JSON.parse(readFileSync(builder)).version, '26.17.0')
  const hashes = assertPeBuilderFiles(Object.fromEntries(Object.keys(builderFiles).map(path => [path, readFileSync(join(dirname(builder), path))])))
  const metadata = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json')))
  const m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)))
  assert.equal(metadata.version, '0.2.1-rc.3')
  assertNoPeOverrides(process.env, {}, metadata)
  if (mode === 'preflight') {
    writeFileSync(versionOrOutput, JSON.stringify({ builderVersion: '26.17.0', source: m.source, moduleSha256: hashes,
      ambientVersionOverridesAbsent: true, scope: 'Locked builder PE version semantics; actual package resources remain unverified' }, null, 2) + '\n')
    return
  }
  assert([m.version, m.upgradeVersion].includes(versionOrOutput), 'Package version is not sealed')
  const configuration = require('js-yaml').load(readFileSync(configFile, 'utf8'))
  const info = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/u, ''))
  const result = assertPeIdentity(info, versionOrOutput, configuration, metadata, process.env)
  writeFileSync(report, JSON.stringify({ ...info, ...result, source: m.source, builderVersion: '26.17.0', moduleSha256: hashes }, null, 2) + '\n')
}
if (import.meta.main) main()
