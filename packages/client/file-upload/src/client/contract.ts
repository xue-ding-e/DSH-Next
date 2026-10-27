import type { FileAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploadValue, ImageUploadValue } from '../types.ts'

/** Browser request body accepted by the background file-upload service. */
export type FileUploadBody = Blob | ReadableStream<Uint8Array>

/** Monotone byte progress reported while a browser body is consumed. */
export interface FileUploadProgress {
  readonly loaded: number
  readonly total?: number
}

/** Browser upload service addressed by one Session identity. */
export interface FileUploadService {
  /**
   * Read exact bytes owned by a pending user occurrence or its durable recall record.
   * @param sessionId - Session that owns the pending occurrence or recall record.
   * @param itemId - User message identity bound to the occurrence.
   * @param attachment - Durable file reference whose identity and byte length must match.
   * @param signal - Optional cancellation for the active download.
   * @param recallRequestId - Optional committed recall identity used to recover a lost response.
   * @returns The verified file bytes and stored name, using application/octet-stream.
   */
  readQueuedFile(sessionId: SessionId, itemId: MessageId, attachment: FileAttachmentRef, signal?: AbortSignal, recallRequestId?: Branded<'session-request-id'>): Promise<File>
  /**
   * Store one file for a Session. Blob and stream bodies use
   * the background carrier; exact bytes use Remote.
   * @param sessionId - Session that owns the staged receipt.
   * @param data - browser Blob, exact bytes, or a one-shot byte stream.
   * @param name - optional display name.
   * @param signal - optional cancellation for the active upload.
   * @param onProgress - optional byte-progress observer for background bodies.
   * @returns the staged receipt and durable file reference, or a business error.
   */
  upload(
    sessionId: SessionId,
    data: Blob | Uint8Array | ReadableStream<Uint8Array>,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<RemoteResult<FileUploadValue>>
  /**
   * Store one prompt image for a Session through the background carrier. The
   * Host validates, normalizes, and stores it as prompt admission would, and a
   * later prompt cites the receipt in a file part.
   * @param sessionId - Session that owns the staged receipt.
   * @param data - browser image Blob.
   * @param mediaType - declared image media type.
   * @param name - optional display name.
   * @param signal - optional cancellation for the active upload.
   * @param onProgress - optional byte-progress observer.
   * @returns the staged receipt and normalized image reference, or a business error.
   */
  uploadImage(
    sessionId: SessionId,
    data: Blob,
    mediaType: ImageMediaType,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: FileUploadProgress) => void,
  ): Promise<RemoteResult<ImageUploadValue>>
}
