import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { FileUploadRuntime } from '../src/client/runtime.ts'

const attachment: FileAttachmentRef = { attachmentId: 'file-id' as never, name: 'report.pdf', bytes: 3 }

afterEach(() => { vi.unstubAllGlobals() })

describe('queued file preflight', () => {
  it('reads scoped authenticated bytes into a real File before recall', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }))
    vi.stubGlobal('__DSH_FILE_UPLOAD__', { fetch })
    const runtime = new FileUploadRuntime(new Context())
    const file = await runtime.readQueuedFile('session' as never, 'queued' as never, attachment)
    expect(file.name).toBe('report.pdf')
    expect(file.type).toBe('application/octet-stream')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3])
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'api/session/readQueuedFile?sessionId=session&itemId=queued&attachmentId=file-id',
      { method: 'GET', credentials: 'include' },
    )
  })

  it.each([{ bytes: [1, 2] }, { bytes: [1, 2, 3, 4] }])('refuses a body that differs from the durable byte count: %j', async ({ bytes }) => {
    vi.stubGlobal('__DSH_FILE_UPLOAD__', { fetch: async () => new Response(new Uint8Array(bytes)) })
    const runtime = new FileUploadRuntime(new Context())
    await expect(runtime.readQueuedFile('session' as never, 'queued' as never, attachment)).rejects.toThrow()
  })

  it('does not read on cancellation and refuses an item already claimed by the agent', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('__DSH_FILE_UPLOAD__', { fetch })
    const runtime = new FileUploadRuntime(new Context())
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.readQueuedFile('session' as never, 'queued' as never, attachment, controller.signal)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await expect(runtime.readQueuedFile('session' as never, 'queued' as never, attachment)).rejects.toThrow('no longer available')
  })
})
