import assert from 'node:assert/strict'
import { it } from 'vitest'
import { handleQueuedFileHttp } from '../src/queued-file-route.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileUploads } from '../src/index.ts'

const file = { attachmentId: brandString<AttachmentId>('test-file'), name: '中文 & notes.txt', bytes: 3 }
const request = (query = '?sessionId=session&itemId=pending&attachmentId=test-file', method = 'GET') =>
  new Request(`http://host/api/session/readQueuedFile${query}`, { method })

it('requires GET and all three opaque identities before reading', async () => {
  let reads = 0
  const service = { readQueuedFile: async () => { reads++; throw new Error('must not read') } }
  assert.equal((await handleQueuedFileHttp(service, request('', 'POST'))).status, 405)
  for (const query of ['', '?sessionId=s', '?sessionId=s&itemId=i', '?itemId=i&attachmentId=a']) {
    assert.equal((await handleQueuedFileHttp(service, request(query))).status, 400)
  }
  assert.equal(reads, 0)
})

it('streams exact binary chunks with no caching and forwards the request cancellation', async () => {
  const input = request()
  const service: Pick<FileUploads, 'readQueuedFile'> = {
    async readQueuedFile(value) {
      assert.equal(value.sessionId, 'session'); assert.equal(value.itemId, 'pending')
      assert.equal(value.attachmentId, 'test-file'); assert.equal(value.signal, input.signal)
      return { file, data: (async function* () { yield Uint8Array.of(0, 255); yield Uint8Array.of(1) })() }
    },
  }
  const response = await handleQueuedFileHttp(service, input)
  assert.equal(response.headers.get('content-length'), '3')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(0, 255, 1))
})

it('contains unavailable-session and storage details before creating a response body', async () => {
  const response = await handleQueuedFileHttp({ readQueuedFile: async () => { throw new Error('/private/secret') } }, request())
  assert.equal(response.status, 409)
  assert.equal((await response.text()).includes('/private/secret'), false)
})

it('propagates an integrity failure instead of returning a truncated successful File', async () => {
  const response = await handleQueuedFileHttp({ readQueuedFile: async () => ({
    file, data: (async function* () { yield Uint8Array.of(0); throw new Error('digest mismatch') })(),
  }) }, request())
  await assert.rejects(response.arrayBuffer(), /digest mismatch/)
})

it('closes the provider iterator when the consumer cancels', async () => {
  let closed = false
  const response = await handleQueuedFileHttp({ readQueuedFile: async () => ({
    file, data: (async function* () { try { yield Uint8Array.of(0); yield Uint8Array.of(1) } finally { closed = true } })(),
  }) }, request())
  const reader = response.body?.getReader()
  assert(reader)
  await reader.read(); await reader.cancel()
  assert.equal(closed, true)
})

it('forwards a recall operation token without changing the bound Session or occurrence', async () => {
  const input = request('?sessionId=session&itemId=pending&attachmentId=test-file&recallRequestId=recovered')
  const response = await handleQueuedFileHttp({ async readQueuedFile(value) {
    assert.equal(value.recallRequestId, 'recovered')
    assert.equal(value.sessionId, 'session'); assert.equal(value.itemId, 'pending')
    return { file, data: (async function* () { yield Uint8Array.of(0, 1, 2) })() }
  } }, input)
  assert.equal((await response.arrayBuffer()).byteLength, 3)
})
