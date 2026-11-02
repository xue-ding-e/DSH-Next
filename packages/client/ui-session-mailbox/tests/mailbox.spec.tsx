import { draftPartition, sessionDraftStore } from '../src/client/drafts.ts'
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MailboxMessage } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'
import { MailboxDialog } from '../src/client/MailboxDialog.tsx'
import { InboxPanel } from '../src/client/InboxPanel.tsx'
import { selectedOperation, type MailboxRemote } from '../src/client/transport.ts'

afterEach(() => { cleanup(); sessionStorage.clear() })
const A = SessionId('source')
const B = SessionId('target')
function remote(): MailboxRemote {
  return { grant: vi.fn(async () => ({ handle: 'grant' })), prepare: vi.fn(async () => ({ handle: 'selection' })), execute: vi.fn(async () => []), revoke: vi.fn(async () => {}) }
}
it('requires explicit destination and confirmation, disables repeated clicks, and revokes after sending', async () => {
  const api = remote()
  render(<MailboxDialog sessionId={A} targets={[{ id: A, title: 'Source' }, { id: B, title: 'Target' }]} remote={api} close={() => {}} />)
  expect(api.grant).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: B } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'plain content' } })
  const button = screen.getByText('Confirm queue-only send')
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => { expect(api.execute).toHaveBeenCalledTimes(1) })
  expect(api.grant).toHaveBeenCalledWith({ action: 'send', source: A, target: B })
  expect(api.prepare).toHaveBeenCalledWith('grant', expect.objectContaining({ action: 'send', text: 'plain content' }))
  expect(api.revoke).toHaveBeenCalledWith('grant')
})
it('withdraws a grant whose reply arrives after the dialog action was cancelled', async () => {
  const api = remote()
  const grant = Promise.withResolvers<{ handle: string }>()
  vi.mocked(api.grant).mockReturnValue(grant.promise)
  const abort = new AbortController()
  const result = selectedOperation(api, { action: 'inbox', target: B }, { action: 'inbox' }, abort.signal)
  const rejection = expect(result).rejects.toThrow()
  abort.abort()
  grant.resolve({ handle: 'late' })
  await rejection
  expect(api.prepare).not.toHaveBeenCalled()
  expect(api.revoke).toHaveBeenCalledWith('late')
})
it('renders hostile content only as text and requires explicit read acknowledgement', async () => {
  const ack = vi.fn()
  const record = { id: 'receipt', source: A, target: B, text: '<img src=x onerror="alert(1)">', status: 'queued' } as MailboxMessage
  const view = render(<InboxPanel records={[record]} busy={false} acknowledge={ack} />)
  expect(view.container.querySelector('img')).toBeNull()
  expect(screen.getByText(record.text)).toBeTruthy()
  expect(ack).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByText('Acknowledge read')) })
  expect(ack).toHaveBeenCalledWith(record)
})

it('reconciles an unknown send with the original request identity instead of creating another message', async () => {
  const api = remote()
  vi.mocked(api.execute).mockRejectedValueOnce(new Error('reply lost'))
  render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} close={() => {}} />)
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: B } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'unchanged' } })
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await screen.findByText(/Result unavailable/)
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await waitFor(() => { expect(api.prepare).toHaveBeenCalledTimes(2) })
  expect(vi.mocked(api.prepare).mock.calls[0]?.[1]).toEqual(vi.mocked(api.prepare).mock.calls[1]?.[1])
})
it('withdraws an outstanding selection when its Session dialog unmounts', async () => {
  const api = remote()
  const prepared = Promise.withResolvers<{ handle: string }>()
  vi.mocked(api.prepare).mockReturnValue(prepared.promise)
  const view = render(<MailboxDialog sessionId={A} targets={[]} remote={api} close={() => {}} />)
  fireEvent.click(screen.getByText('Read this session’s inbox'))
  await waitFor(() => { expect(api.prepare).toHaveBeenCalledTimes(1) })
  view.unmount()
  await act(async () => { prepared.resolve({ handle: 'old-session' }) })
  expect(api.execute).not.toHaveBeenCalled()
  expect(api.revoke).toHaveBeenCalledWith('grant')
})

it('persists unknown send identity before transport and restores it on dialog reopen', async () => {
  const api = remote()
  const drafts = sessionDraftStore(sessionStorage, 'fixture-host')
  vi.mocked(api.execute).mockRejectedValueOnce(new Error('reply lost'))
  const view = render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} drafts={drafts} close={() => {}} />)
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: B } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'retry across reopen' } })
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await screen.findByText(/Result unavailable/)
  const first = vi.mocked(api.prepare).mock.calls[0]?.[1]
  view.unmount()
  render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} drafts={drafts} close={() => {}} />)
  expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('retry across reopen')
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await waitFor(() => { expect(api.prepare).toHaveBeenCalledTimes(2) })
  expect(vi.mocked(api.prepare).mock.calls[1]?.[1]).toEqual(first)
  await waitFor(() => { expect(drafts.read(A)).toBeUndefined() })
})
it('does not contact the Host if retry state cannot be persisted', async () => {
  const api = remote()
  const drafts = sessionDraftStore({ getItem: () => null, setItem: () => { throw new Error('quota') } }, 'fixture-host')
  render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} drafts={drafts} close={() => {}} />)
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: B } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'not silently retried' } })
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await screen.findByText(/No new send request was made/)
  expect(api.grant).not.toHaveBeenCalled()
})

it('partitions pending drafts by endpoint, logical mailbox realm, owner and source without URL credentials', () => {
  const first = draftPartition('https://user:password@fixture.invalid/app/?token=secret#auth', { realm: 'realm-a', owner: 'single-owner' })
  expect(first).not.toMatch(/user|password|token|secret|auth/)
  const otherHost = draftPartition('https://fixture.invalid/app/', { realm: 'realm-b', owner: 'single-owner' })
  const otherEndpoint = draftPartition('https://other.invalid/app/', { realm: 'realm-a', owner: 'single-owner' })
  const store = sessionDraftStore(sessionStorage, first)
  const saved = store.save(A, B, 'retained only here')
  expect(store.read(B)).toBeUndefined()
  expect(sessionDraftStore(sessionStorage, otherHost).read(A)).toBeUndefined()
  expect(sessionDraftStore(sessionStorage, otherEndpoint).read(A)).toBeUndefined()
  expect(sessionDraftStore(sessionStorage, first).read(A)).toEqual(saved)
  expect(() => store.save(A, B, 'changed body')).toThrow()
})

it('rejects new whitespace before persisting or granting, and unlocks only an authoritative rejection', async () => {
  const api = remote()
  const drafts = sessionDraftStore(sessionStorage, 'known-reject')
  expect(() => drafts.save(A, B, '   ')).toThrow()
  render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} drafts={drafts} close={() => {}} />)
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: B } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: '   ' } })
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  expect(api.grant).not.toHaveBeenCalled()
  vi.mocked(api.execute).mockResolvedValue({ outcome: 'not-accepted' })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: ('a\n').repeat(8192) } })
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Not queued') })
  expect(drafts.read(A)).toBeUndefined()
  expect(screen.getByLabelText<HTMLTextAreaElement>('Message').disabled).toBe(false)
})

it('reconciles an old whitespace pending identity without replacing its body or id', async () => {
  sessionStorage.setItem('dsh.session-mailbox.pending:legacy', JSON.stringify([{ source: A, target: B, requestId: 'legacy-id', text: '   ' }]))
  const drafts = sessionDraftStore(sessionStorage, 'legacy')
  const api = remote()
  vi.mocked(api.execute).mockResolvedValue({ outcome: 'not-accepted' })
  render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} drafts={drafts} close={() => {}} />)
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await waitFor(() => { expect(drafts.read(A)).toBeUndefined() })
  expect(api.prepare).toHaveBeenCalledWith('grant', { action: 'send', requestId: 'legacy-id', text: '   ' })
})

it('retains locked unknown drafts and rejects a new raw UTF8 upper bound plus one', async () => {
  const drafts = sessionDraftStore(sessionStorage, 'unknown-retained')
  expect(() => drafts.save(A, B, 'a'.repeat(16_385))).toThrow()
  const api = remote()
  vi.mocked(api.execute).mockRejectedValue(new Error('transport outcome unknown'))
  render(<MailboxDialog sessionId={A} targets={[{ id: B, title: 'Target' }]} remote={api} drafts={drafts} close={() => {}} />)
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: B } })
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'pending body' } })
  fireEvent.click(screen.getByText('Confirm queue-only send'))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Result unavailable') })
  expect(screen.getByLabelText<HTMLTextAreaElement>('Message').disabled).toBe(true)
  expect(() => drafts.save(A, B, 'changed body')).toThrow()
  expect(drafts.read(A)?.text).toBe('pending body')
})
