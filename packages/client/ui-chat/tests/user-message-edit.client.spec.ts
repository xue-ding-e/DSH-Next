import { describe, expect, it, vi } from 'vitest'
import { SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PromptContentPart, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessageEdit, canEditUserMessage } from '../src/client/chat/user-message-edit.ts'
import type { UserMessageNode } from '../src/client/contract/snapshot.ts'

type FileUploadReceiptId = Extract<PromptContentPart, { type: 'file' }>['receiptId']

const SOURCE = 'message-edit-source' as SessionId
const CHILD = 'message-edit-child' as SessionId
const IMAGE: ImageAttachmentRef = {
  attachmentId: 'diagram-image' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png',
  bytes: 1, width: 1, height: 1, name: 'diagram.png',
}
const FILE: FileAttachmentRef = { attachmentId: 'report-file' as FileAttachmentRef['attachmentId'], name: 'report.csv', bytes: 3 }
const MESSAGE: UserMessageNode = {
  kind: 'user', seq: 7, time: 1000, messageId: MessageId('message-to-edit'), source: { kind: 'user' },
  content: [{ type: 'text', text: '@guide.md original' }, { type: 'image', attachment: IMAGE }],
}

function fixture(message = MESSAGE) {
  const sourcePrompt = vi.fn<SessionFace['prompt']>()
  const source = { sessionId: SOURCE, session: { prompt: sourcePrompt } }
  const prompt = vi.fn<SessionFace['prompt']>().mockResolvedValue({ ok: true, value: { accepted: true } })
  let identity = 0
  const beginSubmission = vi.fn<SessionFace['beginSubmission']>(() => ({
    requestId: `edit-request-${++identity}` as SessionRequestId, abandon: vi.fn(),
  }))
  const child = { sessionId: CHILD, session: { prompt, beginSubmission } }
  const fork = vi.fn<ISessions['fork']>(async (options) => { options.onCreated?.(CHILD); return CHILD })
  const release = vi.fn()
  let retained = false
  const using: Parameters<typeof createUserMessageEdit>[0]['sessions']['using'] = async (_id, _options, operation) => {
    retained = true
    try {
      return await operation({ ready: Promise.resolve(child) })
    } finally { retained = false; release() }
  }
  const readImage = vi.fn(async (attachment: ImageAttachmentRef) => ({
    type: 'image' as const, mediaType: attachment.mediaType, data: 'eA==', name: attachment.name!,
  }))
  let receipt = 0
  const stageFile = vi.fn<Parameters<typeof createUserMessageEdit>[0]['stageFile']>(async () => {
    expect(retained).toBe(true)
    expect(fork).toHaveBeenCalledOnce()
    return { receiptId: `history-receipt-${++receipt}` as FileUploadReceiptId, file: FILE }
  })
  const openSession = vi.fn(() => { expect(retained).toBe(true) })
  const deps = { source, sessions: { fork, using, binding: () => source }, readImage, stageFile, openSession }
  return { operation: createUserMessageEdit(deps, message), deps, fork, readImage, stageFile,
    prompt, beginSubmission, openSession, release, sourcePrompt }
}

describe('confirmed message replacements', () => {
  it('prepares locally, forks before the source message, preserves images and reference text, and sends only to the child', async () => {
    const before = structuredClone(MESSAGE)
    const f = fixture()
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.readImage).not.toHaveBeenCalled()
    expect(await f.operation.submit('@guide.md replacement', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork.mock.calls[0]?.[0]).toMatchObject({ sessionId: SOURCE, atSeq: 6, increaseTitle: true })
    expect(f.prompt).toHaveBeenCalledWith([
      { type: 'text', text: '@guide.md replacement' },
      { type: 'image', mediaType: 'image/png', data: 'eA==', name: 'diagram.png' },
    ], 'queue', expect.any(AbortSignal), 'edit-request-1')
    expect(f.beginSubmission.mock.calls[0]?.[0].attachments).toEqual([
      { type: 'image', value: { previewUrl: 'data:image/png;base64,eA==', name: 'diagram.png' } },
    ])
    expect(f.openSession).toHaveBeenCalledWith(CHILD)
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.sourcePrompt).not.toHaveBeenCalled()
    expect(MESSAGE).toEqual(before)
  })

  it('allows retrying attachment reads before any branch is created', async () => {
    const f = fixture()
    f.readImage.mockRejectedValueOnce(new Error('image unavailable'))
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(f.fork).not.toHaveBeenCalled()
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledOnce()
  })

  it('reuses the created child after an explicit send refusal', async () => {
    const f = fixture()
    f.prompt.mockResolvedValueOnce({ ok: false, error: new RemoteError('session/agent-busy', 'Rejected', { reason: 'busy' }) })
    expect(await f.operation.submit('first revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(f.openSession).not.toHaveBeenCalled()
    expect(await f.operation.submit('updated revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.prompt.mock.calls[1]?.[0][0]).toEqual({ type: 'text', text: 'updated revision' })
    expect(f.prompt.mock.calls.map(call => call[3])).toEqual(['edit-request-1', 'edit-request-2'])
  })

  it('checks a lost send reply using the same child, request identity, and exact content', async () => {
    const f = fixture()
    f.prompt.mockRejectedValueOnce(new Error('lost response'))
    expect(await f.operation.submit('sent revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'uncertain-send' })
    expect(await f.operation.submit('must not replace an uncertain submission', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.beginSubmission).toHaveBeenCalledOnce()
    expect(f.prompt.mock.calls[1]?.[0]).toBe(f.prompt.mock.calls[0]?.[0])
    expect(f.prompt.mock.calls[1]?.[3]).toBe(f.prompt.mock.calls[0]?.[3])
  })

  it('does not create duplicate branches when a fork outcome is unknown', async () => {
    const f = fixture()
    f.fork.mockRejectedValueOnce(new Error('connection lost'))
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'uncertain-fork' })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'uncertain-fork' })
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.prompt).not.toHaveBeenCalled()
  })

  it('allows retrying a fork that the Host explicitly refused', async () => {
    const f = fixture()
    f.fork.mockRejectedValueOnce(new SessionForkError(
      new RemoteError('session/writer-held', 'Writer held', { sessionId: SOURCE }), SOURCE,
    ))
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledTimes(2)
  })

  it('retains the child identity when its title preparation fails after creation', async () => {
    const f = fixture()
    f.fork.mockImplementationOnce(async (options) => { options.onCreated?.(CHILD); throw new Error('title failed') })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledOnce()
  })

  it('shares a pending confirmation and prevents sending or navigation after cancellation', async () => {
    const f = fixture()
    const created = Promise.withResolvers<SessionId>()
    f.fork.mockReturnValueOnce(created.promise)
    const controller = new AbortController()
    const first = f.operation.submit('revision', controller.signal)
    expect(f.operation.submit('duplicate', controller.signal)).toBe(first)
    await vi.waitFor(() => { expect(f.fork).toHaveBeenCalledOnce() })
    controller.abort()
    created.resolve(CHILD)
    await expect(first).rejects.toThrow()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.openSession).not.toHaveBeenCalled()
  })

  it('never resends an accepted prompt when navigation needs retrying', async () => {
    const f = fixture()
    f.openSession.mockImplementationOnce(() => { throw new Error('navigation unavailable') })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledTimes(2)
  })

  it('preserves file-only messages and ordered mixed attachments using child-owned receipts', async () => {
    for (const content of [
      [{ type: 'file' as const, attachment: FILE }],
      [{ type: 'file' as const, attachment: FILE }, ...MESSAGE.content],
    ]) {
      const message: UserMessageNode = { ...MESSAGE, content }
      const before = structuredClone(message)
      const f = fixture(message)
      expect(canEditUserMessage(message)).toBe(true)
      expect(f.stageFile).not.toHaveBeenCalled()
      expect(await f.operation.submit('File revision', new AbortController().signal)).toEqual({ kind: 'sent' })
      expect(f.stageFile).toHaveBeenCalledWith(CHILD, {
        sourceSessionId: SOURCE, messageId: MESSAGE.messageId, contentIndex: 0, attachmentId: FILE.attachmentId,
      }, expect.any(AbortSignal))
      expect(f.prompt.mock.calls[0]?.[0]).toEqual([
        ...content.length === 1 ? [{ type: 'text', text: 'File revision' }] : [],
        { type: 'file', receiptId: 'history-receipt-1' },
        ...content.length === 1 ? [] : [{ type: 'text', text: 'File revision' },
          { type: 'image', mediaType: 'image/png', data: 'eA==', name: 'diagram.png' }],
      ])
      expect(f.beginSubmission.mock.calls[0]?.[0].attachments[0]).toEqual({ type: 'file', value: FILE })
      expect(message).toEqual(before)
      expect(f.sourcePrompt).not.toHaveBeenCalled()
    }
  })

  it('retries file staging on the existing child without sending incomplete content', async () => {
    const f = fixture({ ...MESSAGE, content: [...MESSAGE.content, { type: 'file', attachment: FILE }] })
    f.stageFile.mockRejectedValueOnce(new Error('history unavailable'))
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.beginSubmission).not.toHaveBeenCalled()
    expect(f.openSession).not.toHaveBeenCalled()
    expect(await f.operation.submit('updated', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.stageFile).toHaveBeenCalledTimes(2)
  })

  it('keeps separate receipts and names for repeated bytes in different content positions', async () => {
    const renamed = { ...FILE, name: 'second-report.csv' }
    const f = fixture({ ...MESSAGE, content: [{ type: 'file', attachment: FILE },
      ...MESSAGE.content, { type: 'file', attachment: renamed }] })
    f.stageFile.mockResolvedValueOnce({ receiptId: 'first-file' as FileUploadReceiptId, file: FILE })
      .mockResolvedValueOnce({ receiptId: 'second-file' as FileUploadReceiptId, file: renamed })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.stageFile.mock.calls.map(call => call[1].contentIndex)).toEqual([0, 3])
    expect(f.prompt.mock.calls[0]?.[0]).toEqual([
      { type: 'file', receiptId: 'first-file' }, { type: 'text', text: 'revision' },
      { type: 'image', mediaType: 'image/png', data: 'eA==', name: 'diagram.png' },
      { type: 'file', receiptId: 'second-file' },
    ])
    expect(f.beginSubmission.mock.calls[0]?.[0].attachments.filter(part => part.type === 'file')).toEqual([
      { type: 'file', value: FILE }, { type: 'file', value: renamed },
    ])
  })

  it('retains exact file receipts when checking an uncertain send', async () => {
    const fileMessage: UserMessageNode = {
      ...MESSAGE, content: [...MESSAGE.content, { type: 'file', attachment: FILE }],
    }
    const f = fixture(fileMessage)
    f.prompt.mockRejectedValueOnce(new Error('lost response'))
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'uncertain-send' })
    expect(await f.operation.submit('different text', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.stageFile).toHaveBeenCalledOnce()
    expect(f.prompt.mock.calls[1]?.[0]).toBe(f.prompt.mock.calls[0]?.[0])
    expect(f.prompt.mock.calls[1]?.[3]).toBe(f.prompt.mock.calls[0]?.[3])
  })

  it('refreshes rejected file receipts while reusing the same child', async () => {
    const f = fixture({ ...MESSAGE, content: [{ type: 'file', attachment: FILE }] })
    f.prompt.mockResolvedValueOnce({ ok: false,
      error: new RemoteError('session/attachment-invalid', 'Receipt expired', { reason: 'FILE_NOT_STAGED' }) })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'failed', reason: 'retry' })
    expect(await f.operation.submit('revision', new AbortController().signal)).toEqual({ kind: 'sent' })
    expect(f.fork).toHaveBeenCalledOnce()
    expect(f.stageFile).toHaveBeenCalledTimes(2)
    expect(f.prompt.mock.calls[1]?.[0]).toContainEqual({ type: 'file', receiptId: 'history-receipt-2' })
  })

  it('does not submit a file receipt returned after cancellation', async () => {
    const f = fixture({ ...MESSAGE, content: [{ type: 'file', attachment: FILE }] })
    const staged = Promise.withResolvers<Awaited<ReturnType<typeof f.deps.stageFile>>>()
    f.stageFile.mockReturnValueOnce(staged.promise)
    const controller = new AbortController()
    const pending = f.operation.submit('revision', controller.signal)
    await vi.waitFor(() => { expect(f.stageFile).toHaveBeenCalledOnce() })
    controller.abort()
    staged.resolve({ receiptId: 'cancelled-receipt' as FileUploadReceiptId, file: FILE })
    expect(await pending).toEqual({ kind: 'failed', reason: 'retry' })
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.openSession).not.toHaveBeenCalled()
  })
})
