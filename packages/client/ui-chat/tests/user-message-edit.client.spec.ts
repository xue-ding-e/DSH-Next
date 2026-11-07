import { describe, expect, it, vi } from 'vitest'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { canEditUserMessage, createUserMessageEdit } from '../src/client/chat/user-message-edit.ts'
import type { UserMessageNode } from '../src/client/contract/snapshot.ts'

const SOURCE = 'message-edit-source' as SessionId
const IMAGE: ImageAttachmentRef = {
  attachmentId: 'diagram-image' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png',
  bytes: 1, width: 1, height: 1, name: 'diagram.png',
}
const MESSAGE: UserMessageNode = {
  kind: 'user', seq: 7, time: 1000, messageId: MessageId('message-to-edit'), source: { kind: 'user' },
  content: [{ type: 'text', text: 'original' }, { type: 'image', attachment: IMAGE }],
}

function fixture() {
  const edit = vi.fn<SessionFace['edit']>().mockResolvedValue({ ok: true, value: { accepted: true, messageSeq: 12 } })
  const session = { sessionId: SOURCE, edit }
  const operation = createUserMessageEdit({ source: { sessionId: SOURCE, session } }, MESSAGE)
  return { edit, operation }
}

describe('same-session user-message replacements', () => {
  it('sends the replacement to the original Session identity', async () => {
    const f = fixture()
    await expect(f.operation.submit('replacement', new AbortController().signal)).resolves.toEqual({ kind: 'sent' })
    expect(f.edit).toHaveBeenCalledExactlyOnceWith(7, 7, 'replacement', expect.any(AbortSignal))
  })

  it('retries a stale admission without creating or opening another Session', async () => {
    const f = fixture()
    f.edit.mockResolvedValueOnce({ ok: false, error: new RemoteError('session/edit-stale', 'changed', {
      sessionId: SOURCE, messageSeq: 7,
    }) })
    await expect(f.operation.submit('first', new AbortController().signal)).resolves.toEqual({ kind: 'failed', reason: 'retry' })
    await expect(f.operation.submit('second', new AbortController().signal)).resolves.toEqual({ kind: 'sent' })
    expect(f.edit.mock.calls.map(call => call[0])).toEqual([7, 7])
  })

  it('does not issue a second request after same-session acceptance', async () => {
    const f = fixture()
    await f.operation.submit('accepted', new AbortController().signal)
    await expect(f.operation.submit('ignored', new AbortController().signal)).resolves.toEqual({ kind: 'sent' })
    expect(f.edit).toHaveBeenCalledOnce()
  })

  it('allows attachment-only edits and rejects unsupported message identities', () => {
    expect(canEditUserMessage({ ...MESSAGE, content: [{ type: 'image', attachment: IMAGE }] })).toBe(true)
    expect(canEditUserMessage({ ...MESSAGE, source: { kind: 'runtime-context' } as never })).toBe(false)
    expect(canEditUserMessage({ ...MESSAGE, messageId: undefined as never })).toBe(false)
  })
})
