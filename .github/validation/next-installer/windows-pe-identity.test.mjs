import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertNoPeOverrides, assertPeBuilderFiles, assertPeIdentity, buildNumberVariables } from './windows-pe-identity.mjs'

const version = '0.2.1-rc.3.20261029.1'
const fixture = (value = version) => ({ ProductName: 'DSH Next', FileVersion: value, ProductVersion: '0.2.1.0',
  ProductMajorPart: 0, ProductMinorPart: 2, ProductBuildPart: 1, ProductPrivatePart: 0 })
const config = value => ({ extraMetadata: { version: value } })

test('each actual full release version retains its own FileVersion despite the same numeric ProductVersion', () => {
  for (const value of [version, '0.2.1-rc.3.20261029.2']) {
    assert.deepEqual(assertPeIdentity(fixture(value), value, config(value), {}, {}),
      { version: value, numericProductVersion: '0.2.1.0', peAttested: true })
  }
})
test('wrong product, old full version, full text used as numeric version, and changed numeric resources are rejected', () => {
  for (const [key, value] of [['ProductName', 'Electron'], ['FileVersion', '0.2.1-rc.3.20261029.2'],
    ['ProductVersion', version], ['ProductMajorPart', 1], ['ProductMinorPart', 0], ['ProductBuildPart', 0], ['ProductPrivatePart', 1]]) {
    assert.throws(() => assertPeIdentity({ ...fixture(), [key]: value }, version, config(version), {}, {}))
  }
  assert.throws(() => assertPeIdentity(fixture(), version, config('0.2.1-rc.3.20261029.2'), {}, {}))
})
test('all supported ambient, configuration and metadata version overrides fail closed', () => {
  for (const key of buildNumberVariables) for (const value of ['1', '']) {
    assert.throws(() => assertNoPeOverrides({ [key]: value }, {}, {}))
  }
  for (const key of ['buildVersion', 'buildNumber']) assert.throws(() => assertNoPeOverrides({}, { [key]: '1' }, {}))
  for (const key of ['shortVersion', 'shortVersionWindows']) {
    assert.throws(() => assertNoPeOverrides({}, {}, { [key]: '1' }))
    assert.throws(() => assertNoPeOverrides({}, { extraMetadata: { [key]: '1' } }, {}))
  }
})
test('missing or unreviewed builder PE implementation bytes cannot authorize resources', () => {
  assert.throws(() => assertPeBuilderFiles({}))
  assert.throws(() => assertPeBuilderFiles({ 'out/winPackager.js': Buffer.from('unreviewed builder') }))
})
