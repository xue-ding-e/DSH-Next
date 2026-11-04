import { afterEach, expect, it, vi } from 'vitest'
import type {
  DesktopQuestionNotificationEvent, DesktopQuestionNotificationResult, DesktopQuestionNotifications,
} from '../src/desktop-notifications.ts'
import { NativeQuestionNotifications } from '../src/client/native-notifications.ts'

afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  let listener: ((event: DesktopQuestionNotificationEvent) => void) | undefined
  const removed = vi.fn()
  const api = {
    show: vi.fn<DesktopQuestionNotifications['show']>().mockResolvedValue('submitted'),
    close: vi.fn<DesktopQuestionNotifications['close']>().mockResolvedValue(undefined),
    subscribe: (callback: (event: DesktopQuestionNotificationEvent) => void) => {
      listener = callback
      return () => { removed(); listener = undefined }
    },
  }
  const open = vi.fn()
  const report = vi.fn()
  const notifier = new NativeQuestionNotifications(api, open, report)
  return { api, open, report, notifier, removed, emit: (event: DesktopQuestionNotificationEvent) => { listener?.(event) } }
}

it('awaits submission and withdrawal when a question resolves during native IPC', async () => {
  const f = fixture()
  const submitted = Promise.withResolvers<DesktopQuestionNotificationResult>()
  const withdrawn = Promise.withResolvers<undefined>()
  f.api.show.mockReturnValueOnce(submitted.promise)
  f.api.close.mockReturnValueOnce(withdrawn.promise)
  f.notifier.show('question', 'Your answer is needed', 'Choose a mode')
  const id = f.api.show.mock.calls[0]![0].id
  f.notifier.close('question')
  f.emit({ type: 'activated', id })
  expect(f.open).not.toHaveBeenCalled()
  expect(f.api.close).not.toHaveBeenCalled()
  let disposed = false
  const disposal = f.notifier.dispose().then(() => { disposed = true })
  expect(f.removed).toHaveBeenCalledOnce()
  submitted.resolve('submitted')
  await vi.waitFor(() => { expect(f.api.close).toHaveBeenCalledExactlyOnceWith(id) })
  expect(disposed).toBe(false)
  withdrawn.resolve(undefined)
  await disposal
  expect(disposed).toBe(true)
})

it('ignores duplicate delivery, closes all outstanding reminders, and ignores late clicks', async () => {
  const f = fixture()
  f.notifier.show('first', 'Title', 'Question')
  f.notifier.show('first', 'Title', 'Question')
  f.notifier.show('second', 'Title', 'Question')
  expect(f.api.show).toHaveBeenCalledTimes(2)
  await f.notifier.dispose()
  expect(f.api.close).toHaveBeenCalledTimes(2)
  f.emit({ type: 'activated', id: f.api.show.mock.calls[0]![0].id })
  expect(f.open).not.toHaveBeenCalled()
})

it('reports failed IPC and attempts withdrawal because delivery is unknown', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = fixture()
  f.api.show.mockRejectedValueOnce(new Error('IPC disconnected'))
  f.notifier.show('question', 'Title', 'Question')
  await vi.waitFor(() => { expect(f.report).toHaveBeenCalledWith('native') })
  await f.notifier.dispose()
  expect(f.api.close).toHaveBeenCalledWith(f.api.show.mock.calls[0]![0].id)
})

it('makes a failed withdrawal visible and prevents its late native click from navigating', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = fixture()
  f.api.close.mockRejectedValueOnce(new Error('native close refused'))
  f.notifier.show('question', 'Title', 'Question')
  const id = f.api.show.mock.calls[0]![0].id
  f.notifier.close('question')
  await vi.waitFor(() => { expect(f.report).toHaveBeenCalledWith('close') })
  f.emit({ type: 'activated', id })
  expect(f.open).not.toHaveBeenCalled()
  await f.notifier.dispose()
})
