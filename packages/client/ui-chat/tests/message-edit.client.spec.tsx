// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ChatNodeViewProps, UserContentInput, UserMessageEdit } from '../src/client/contract/slots.ts'
import type { UserMessageNode } from '../src/client/contract/snapshot.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { en } from '../src/client/locale.ts'
import { createUserContentFixture } from './user-content-component-fixture.tsx'
import { unusedImageLoader } from './reasoning-component-fixture.tsx'
import type { ComponentProps, ReactNode } from 'react'

const t = makeTranslate(en, commonEn)
const IMAGE: ImageAttachmentRef = {
  attachmentId: 'edit-image' as ImageAttachmentRef['attachmentId'], mediaType: 'image/png',
  width: 1, height: 1, bytes: 4, name: 'diagram.png',
}
const MESSAGE: UserMessageNode = {
  kind: 'user', seq: 7, time: 1000, messageId: MessageId('edited-user'), source: { kind: 'user' },
  content: [{ type: 'text', text: 'Original message' }],
}
const { messageId: _messageId, ...SYNTHETIC_MESSAGE } = MESSAGE

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture(operation: UserMessageEdit, message = MESSAGE, available = true, sourceDecoration: ReactNode = null) {
  const begin = vi.fn(() => operation)
  const renderContent = createUserContentFixture()
  const renderFactorySlot: ChatNodeViewProps['renderFactorySlot'] = (name, input) => {
    if (name !== 'conversation.chat.user.content') throw new Error(`Unexpected Factory: ${name}`)
    return renderContent(input as UserContentInput, () => <span>Image attachment</span>, t)
  }
  const renderSlotChainCalls = vi.fn()
  const renderSlotChain: ComponentProps<typeof UserMessageNodeView>['renderSlotChain'] = (name, owner, options) => {
    renderSlotChainCalls(name, owner, options)
    if (name !== 'conversation.chat.user.before') throw new Error(`Unexpected source chain: ${name}`)
    return sourceDecoration ?? options?.fallback ?? null
  }
  const props = {
    node: { key: 'user:edited-user', kind: 'user' as const, id: message.messageId ?? 'synthetic', target: 'chat' as const,
      anchorSeq: message.seq, location: { kind: 'session' as const }, visibility: 'visible' as const, data: message },
    renderFactorySlot, renderSlotChain, loadImage: unusedImageLoader, editUserMessage: available ? begin : undefined, t,
    useTurnData: () => undefined,
    useDisclosure: () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} }),
    useGroupAction: () => { throw new Error('unused group action') },
    openFile: vi.fn(), inspectCall: undefined, forkAt: vi.fn(),
  }
  return { ...render(createElement(UserMessageNodeView, props as never)), begin, renderSlotChain: renderSlotChainCalls }
}

describe('editing a recorded user message', () => {
  it('preserves the durable user source decoration while its inline editor opens and closes', () => {
    const shared = { ...MESSAGE, source: { kind: 'user', principal: { kind: 'share-viewer', shareId: 'shared-origin' } } }
    const submit = vi.fn<UserMessageEdit['submit']>()
    const view = fixture({ submit }, shared, true, <span data-testid="source-origin">Shared sender</span>)
    const origin = view.getByTestId('source-origin')
    expect(view.renderSlotChain).toHaveBeenCalledExactlyOnceWith(
      'conversation.chat.user.before', { source: shared.source, kind: 'user' }, { fallback: null },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    expect(view.begin).toHaveBeenCalledWith(shared)
    expect(view.getByTestId('source-origin')).toBe(origin)
    expect(view.renderSlotChain.mock.lastCall?.[1]).toEqual({ source: shared.source, kind: 'user' })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Original message')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(view.getByTestId('source-origin')).toBe(origin)
    expect(submit).not.toHaveBeenCalled()
  })

  it('opens below the original without sending, and Cancel discards only the edit', () => {
    const submit = vi.fn<UserMessageEdit['submit']>()
    fixture({ submit })
    const edit = screen.getByRole('button', { name: 'Edit and resend' })
    fireEvent.click(edit)
    const editor = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement
    expect(editor.value).toBe('Original message')
    expect(screen.getByText('Original message', { selector: 'span' })).toBeTruthy()
    fireEvent.change(editor, { target: { value: 'Unsent revision' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(edit)
    fireEvent.click(edit)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Original message')
  })

  it('retains a failed draft and resends only after an explicit retry', async () => {
    const first = Promise.withResolvers<Awaited<ReturnType<UserMessageEdit['submit']>>>()
    const submit = vi.fn<UserMessageEdit['submit']>().mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'sent' })
    fixture({ submit })
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Keep this revision' } })
    const form = screen.getByRole('form', { name: 'Edit and resend' })
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sending…' }).disabled).toBe(true)
    await act(async () => { first.resolve({ kind: 'failed', reason: 'retry' }); await first.promise })
    expect(editor.value).toBe('Keep this revision')
    expect(screen.getByRole('alert').textContent).toBe(en['message.editFailed'])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
    expect(submit.mock.calls.map(call => call[0])).toEqual(['Keep this revision', 'Keep this revision'])
  })

  it('keeps original images and reference text while editing', async () => {
    const message: UserMessageNode = {
      ...MESSAGE, content: [{ type: 'image', attachment: IMAGE }, { type: 'text', text: '@docs/guide.md Explain this diagram' }],
    }
    const submit = vi.fn<UserMessageEdit['submit']>().mockResolvedValue({ kind: 'failed', reason: 'retry' })
    const view = fixture({ submit }, message)
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    expect(view.begin).toHaveBeenCalledWith(message)
    expect(screen.getByText('Image attachment')).toBeTruthy()
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(editor.value).toBe('@docs/guide.md Explain this diagram')
    fireEvent.change(editor, { target: { value: '@docs/guide.md Explain the colors' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and send' }))
    await screen.findByRole('alert')
    expect(editor.value).toBe('@docs/guide.md Explain the colors')
    expect(screen.getByText('Image attachment')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Image attachment')).toBeTruthy()
    expect(message.content).toEqual([{ type: 'image', attachment: IMAGE },
      { type: 'text', text: '@docs/guide.md Explain this diagram' }])
  })

  it('keeps a file-only message visible and permits a replacement with no text', async () => {
    const message: UserMessageNode = { ...MESSAGE, content: [{ type: 'file',
      attachment: { attachmentId: IMAGE.attachmentId, name: 'report.csv', bytes: 12 } }] }
    const before = structuredClone(message)
    const submit = vi.fn<UserMessageEdit['submit']>().mockResolvedValue({ kind: 'failed', reason: 'retry' })
    fixture({ submit }, message)
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('')
    expect(screen.getByText('report.csv')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save and send' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Save and send' }))
    await screen.findByRole('alert')
    expect(submit).toHaveBeenCalledWith('', expect.any(AbortSignal))
    expect(screen.getByText('report.csv')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('report.csv')).toBeTruthy()
    expect(message).toEqual(before)
  })

  it('aborts a cancelled attempt and ignores its result after another edit opens', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<UserMessageEdit['submit']>>>()
    const submit = vi.fn<UserMessageEdit['submit']>().mockReturnValue(pending.promise)
    fixture({ submit })
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and send' }))
    const signal = submit.mock.calls[0]![1]
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A new edit' } })
    await act(async () => { pending.resolve({ kind: 'sent' }); await pending.promise })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('A new edit')
  })

  it('cancels pending navigation when its row unmounts', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<UserMessageEdit['submit']>>>()
    const submit = vi.fn<UserMessageEdit['submit']>().mockReturnValue(pending.promise)
    const view = fixture({ submit })
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and send' }))
    const signal = submit.mock.calls[0]![1]
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve({ kind: 'failed', reason: 'retry' }); await pending.promise })
  })

  it('keeps an uncertain send frozen for checking the same submission', async () => {
    const submit = vi.fn<UserMessageEdit['submit']>().mockResolvedValueOnce({ kind: 'failed', reason: 'uncertain-send' })
      .mockResolvedValueOnce({ kind: 'sent' })
    fixture({ submit })
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Confirmed revision' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and send' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('textbox').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
    expect(submit.mock.calls.map(call => call[0])).toEqual(['Confirmed revision', 'Confirmed revision'])
  })

  it('disables empty text and never offers editing without an explicit capability', () => {
    const view = fixture({ submit: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save and send' }).disabled).toBe(true)
    view.unmount()
    fixture({ submit: vi.fn() }, MESSAGE, false)
    expect(screen.queryByRole('button', { name: 'Edit and resend' })).toBeNull()
  })

  it.each([
    SYNTHETIC_MESSAGE,
    { ...MESSAGE, source: { kind: 'subagent' } },
    { ...MESSAGE, seq: 0 },
  ])('hides editing for ineligible content or identity', (message) => {
    fixture({ submit: vi.fn() }, message)
    expect(screen.queryByRole('button', { name: 'Edit and resend' })).toBeNull()
  })
})
