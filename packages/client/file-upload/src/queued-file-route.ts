/** Authenticated byte stream restricted to one pending user message's file. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FileUploads } from './index.ts'

/**
 * Serve a pending file through the existing authenticated Connection registry.
 * @param service - Session-scoped file owner.
 * @param request - document-relative GET carrying opaque identities, not a path.
 * @returns exact bytes or an error before the caller can recall the message.
 */
export async function handleQueuedFileHttp(service: Pick<FileUploads, 'readQueuedFile'>, request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const itemId = query.get('itemId')
  const attachmentId = query.get('attachmentId')
  const recallRequestId = query.get('recallRequestId')
  if (!sessionId || !itemId || !attachmentId) return new Response('pending file identities are required', { status: 400 })
  let result: Awaited<ReturnType<FileUploads['readQueuedFile']>>
  try {
    result = await service.readQueuedFile({
      sessionId: brandString<SessionId>(sessionId),
      itemId: brandString<MessageId>(itemId),
      attachmentId: brandString<AttachmentId>(attachmentId),
      ...(recallRequestId === null ? {} : { recallRequestId: brandString<Branded<'session-request-id'>>(recallRequestId) }),
      signal: request.signal,
    })
  } catch (error) {
    // Authorization/storage details stay on the Host; no filesystem paths reach this route.
    void error
    return new Response('pending file is unavailable', { status: 409, headers: { 'cache-control': 'no-store' } })
  }
  const iterator = result.data[Symbol.asyncIterator]()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next()
        if (item.done) controller.close()
        else controller.enqueue(item.value)
      } catch (error) { controller.error(error) }
    },
    async cancel() { await iterator.return?.() },
  })
  return new Response(body, { headers: {
    'content-type': 'application/octet-stream',
    'content-length': String(result.file.bytes),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } })
}
