import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { installDesktopQuestionNotifications } from '../src/question-notifications.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const notices: Notice[] = []
  const submit = vi.fn<() => void>()
  class Notice extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn(() => { submit() })
    close = vi.fn()
    constructor(readonly options: unknown) { super(); notices.push(this) }
  }
  const handlers = new Map<string, (event: unknown, value: unknown) => unknown>()
  return { Notice, notices, handlers, submit, ipcMain: {
    handle: (channel: string, handler: (event: unknown, value: unknown) => unknown) => { handlers.set(channel, handler) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  } }
})
vi.mock('electron', () => ({ Notification: native.Notice, ipcMain: native.ipcMain }))

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.(); dispose = undefined
  native.notices.length = 0; native.handlers.clear()
  vi.restoreAllMocks(); vi.clearAllMocks(); native.submit.mockReset(); native.Notice.isSupported.mockReturnValue(true)
})

function setup() {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isMinimized: () => true,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }),
  })
  const event = {}
  const authorize = vi.fn((candidate: unknown) => {
    if (candidate !== event) throw new Error('rejected sender')
    return window as never
  })
  dispose = installDesktopQuestionNotifications(authorize)
  const invoke = (channel: string, value: unknown, sender: unknown = event) => native.handlers.get(channel)!(sender, value)
  const show = (id = 'question-1') => invoke(DESKTOP_IPC.questionNotificationShow, { id, title: 'Answer needed', body: 'Choose a mode' })
  return { window, invoke, show, authorize }
}

it('submits real Electron notifications without focusing, then restores and forwards the clicked identity', () => {
  const f = setup()
  expect(f.show()).toBe('submitted')
  f.show('question-2')
  expect(native.notices[0]!.options).toEqual({ title: 'Answer needed', body: 'Choose a mode' })
  expect(native.notices[0]!.show).toHaveBeenCalledOnce()
  expect(f.window.focus).not.toHaveBeenCalled()
  native.notices[1]!.emit('click')
  expect(f.window.restore).toHaveBeenCalledOnce()
  expect(f.window.show).toHaveBeenCalledOnce()
  expect(f.window.focus).toHaveBeenCalledOnce()
  expect(f.window.webContents.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.questionNotificationEvent,
    { type: 'activated', id: 'question-2' })
  expect(native.notices[1]!.close).toHaveBeenCalledOnce()
  expect(native.notices[0]!.close).not.toHaveBeenCalled()
})

it('authorizes show and close before reading renderer input and rejects malformed IPC', () => {
  const f = setup()
  expect(() => f.invoke(DESKTOP_IPC.questionNotificationShow, null, {})).toThrow('rejected sender')
  expect(() => f.invoke(DESKTOP_IPC.questionNotificationClose, 'question-1', {})).toThrow('rejected sender')
  for (const value of [null, {}, { id: '', title: 'Question', body: '' }, { id: 'q', title: 42, body: 'text' }]) {
    expect(() => f.invoke(DESKTOP_IPC.questionNotificationShow, value)).toThrow(TypeError)
  }
  expect(() => f.invoke(DESKTOP_IPC.questionNotificationClose, {})).toThrow(TypeError)
  expect(native.notices).toEqual([])
})

it('withdraws a resolved question and rejects a callback retained before withdrawal', () => {
  const f = setup()
  f.show()
  const notice = native.notices[0]!
  const staleClick = notice.listeners('click')[0] as () => void
  f.invoke(DESKTOP_IPC.questionNotificationClose, 'question-1')
  staleClick()
  expect(f.window.focus).not.toHaveBeenCalled()
  expect(f.window.webContents.send).not.toHaveBeenCalled()
  expect(notice.eventNames()).toEqual([])
  expect(notice.close).toHaveBeenCalledOnce()
})

it.each(['navigation', 'renderer-loss', 'destroyed', 'window-close', 'shutdown'])(
  'withdraws all reminders and document listeners on %s', (reason) => {
    const f = setup()
    f.show(); f.show('question-2')
    if (reason === 'navigation') f.window.webContents.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
    else if (reason === 'renderer-loss') f.window.webContents.emit('render-process-gone')
    else if (reason === 'destroyed') f.window.webContents.emit('destroyed')
    else if (reason === 'window-close') f.window.emit('closed')
    else dispose!()
    for (const notice of native.notices) {
      expect(notice.close).toHaveBeenCalledOnce()
      expect(notice.eventNames()).toEqual([])
      notice.emit('click')
    }
    expect(f.window.webContents.eventNames()).toEqual([])
    expect(f.window.eventNames()).toEqual([])
    expect(f.window.focus).not.toHaveBeenCalled()
    dispose!()
    expect(native.handlers.size).toBe(0)
  },
)

it('keeps reminders through same-document or subframe navigation and native dismissal is harmless', () => {
  const f = setup()
  f.show()
  f.window.webContents.emit('did-start-navigation', {}, 'dsh-app://app/#question', true, true)
  f.window.webContents.emit('did-start-navigation', {}, 'https://example.com/', false, false)
  expect(native.notices[0]!.close).not.toHaveBeenCalled()
  native.notices[0]!.emit('close')
  f.invoke(DESKTOP_IPC.questionNotificationClose, 'question-1')
  expect(native.notices[0]!.close).toHaveBeenCalledOnce()
  expect(native.notices[0]!.eventNames()).toEqual([])
  expect(f.window.webContents.send).not.toHaveBeenCalled()
})

it('keeps timed-out Action Center reminders clickable and withdraws them when the question resolves', () => {
  const f = setup()
  f.show()
  native.notices[0]!.emit('close', { reason: 'timedOut' })
  native.notices[0]!.emit('click')
  expect(f.window.focus).toHaveBeenCalledOnce()
  expect(f.window.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.questionNotificationEvent,
    { type: 'activated', id: 'question-1' })
  f.show('question-2')
  native.notices[1]!.emit('close', { reason: 'timedOut' })
  f.invoke(DESKTOP_IPC.questionNotificationClose, 'question-2')
  expect(native.notices[1]!.close).toHaveBeenCalledOnce()
})

it('reports unsupported and failed delivery without claiming display success', () => {
  const f = setup()
  native.Notice.isSupported.mockReturnValueOnce(false)
  expect(f.show()).toBe('unsupported')
  expect(native.notices).toEqual([])
  f.show()
  native.notices[0]!.emit('failed', {}, 'system policy')
  expect(f.window.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.questionNotificationEvent,
    { type: 'failed', id: 'question-1' })
  expect(native.notices[0]!.eventNames()).toEqual([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // A synchronous show failure has no native callback; the IPC result carries the failure instead.
  native.submit.mockImplementationOnce(() => { throw new Error('unavailable') })
  expect(f.show('question-2')).toBe('failed')
  expect(native.notices[1]!.close).toHaveBeenCalledOnce()
  expect(native.notices[1]!.eventNames()).toEqual([])
})

it('invalidates callbacks even when native withdrawal throws, and continues shutdown cleanup', () => {
  const f = setup()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  f.show(); f.show('question-2')
  const oldClick = native.notices[0]!.listeners('click')[0] as () => void
  native.notices[0]!.close.mockImplementationOnce(() => { throw new Error('close refused') })
  dispose!()
  oldClick()
  expect(f.window.focus).not.toHaveBeenCalled()
  expect(native.notices[1]!.close).toHaveBeenCalledOnce()
  expect(f.window.webContents.eventNames()).toEqual([])
})
