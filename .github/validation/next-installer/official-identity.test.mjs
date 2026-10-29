import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertBuilderContract, assertUuidContract, deriveOfficialGuid } from './official-identity.mjs'

test('official GUID computation uses only the reviewed identity and UUID namespace', () => {
  const namespace = '50e065bc-3134-11e6-9bab-38c9862bdaf3'
  const bytes = Buffer.alloc(16)
  const calls = []
  const UUID = {
    parse(value) { calls.push(['parse', value]); return bytes },
    v5(id, value) { calls.push(['v5', id, value]); return '1bf39983-50d0-5fe0-9ef4-cece76f67c5e' },
  }
  assert.equal(deriveOfficialGuid('com.deepseek.dsh', namespace, UUID), '1bf39983-50d0-5fe0-9ef4-cece76f67c5e')
  assert.deepEqual(calls, [['parse', namespace], ['v5', 'com.deepseek.dsh', bytes]])
  for (const [id, ns] of [['com.deepseek.harness', namespace], ['com.deepseek.dsh', '0'.repeat(36)]]) {
    assert.throws(() => deriveOfficialGuid(id, ns, UUID))
  }
  for (const result of ['random-sentinel', 'e74d59b9-768b-51ae-bb11-7f24bfbafa5a', '1bf39983-50d0-5fe0-9ef4-cece76f67c5f']) {
    assert.throws(() => deriveOfficialGuid('com.deepseek.dsh', namespace, { ...UUID, v5: () => result }))
  }
})

test('unreviewed NSIS or UUID bytes never authorize official registry fixtures', () => {
  assert.throws(() => assertBuilderContract(Buffer.from('getter contract from a different version'), Buffer.from('UUID')), /NSIS GUID implementation changed/u)
  assert.throws(() => assertUuidContract(Buffer.from('unreviewed UUID implementation')), /UUID implementation changed/u)
})
