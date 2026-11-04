/** Owns native question reminders and restricts their IPC to the primary product document. */
import { ipcMain, Notification, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type {
  DesktopQuestionNotification, DesktopQuestionNotificationEvent, DesktopQuestionNotificationResult,
  QuestionNotificationId,
} from '@deepseek-ai/dsh-client-ui-user-questions'
import { DESKTOP_IPC } from './ipc.ts'

/** Native reminders belonging to one renderer document, independent of window visibility. */
interface NotificationOwner {
  readonly notices: Map<QuestionNotificationId, Notification>
  readonly release: () => void
}

/**
 * Install the question notification bridge. Renderer navigation or loss withdraws its reminders.
 * @param authorize - Validates the product origin, owning window, and main frame on every IPC call.
 * @returns Idempotent shutdown cleanup, including IPC and document listeners.
 */
export function installDesktopQuestionNotifications(authorize: (event: IpcMainInvokeEvent) => BrowserWindow): () => void {
  const owners = new Map<BrowserWindow, NotificationOwner>()
  const close = (owner: NotificationOwner, id: QuestionNotificationId): void => {
    const notice = owner.notices.get(id)
    if (notice === undefined) return
    // Invalidate click handlers even if the OS refuses to withdraw the banner.
    owner.notices.delete(id)
    notice.removeAllListeners()
    notice.close()
  }
  const release = (window: BrowserWindow): void => {
    const owner = owners.get(window)
    if (owner === undefined) return
    owners.delete(window)
    owner.release()
    for (const id of owner.notices.keys()) {
      try { close(owner, id) }
      catch (error) { console.error('Desktop question notification cleanup failed', error) }
    }
  }
  const ownerFor = (window: BrowserWindow): NotificationOwner => {
    const existing = owners.get(window)
    if (existing !== undefined) return existing
    const clear = (): void => { release(window) }
    const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPlace) clear()
    }
    const contents = window.webContents
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', clear)
    contents.on('destroyed', clear)
    window.on('closed', clear)
    const owner: NotificationOwner = { notices: new Map(), release: () => {
      contents.off('did-start-navigation', navigation)
      contents.off('render-process-gone', clear)
      contents.off('destroyed', clear)
      window.off('closed', clear)
    } }
    owners.set(window, owner)
    return owner
  }
  const send = (window: BrowserWindow, event: DesktopQuestionNotificationEvent): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    try { window.webContents.send(DESKTOP_IPC.questionNotificationEvent, event) }
    catch (error) { console.error('Desktop question notification callback failed', error) }
  }

  ipcMain.handle(DESKTOP_IPC.questionNotificationShow, (event, value: unknown): DesktopQuestionNotificationResult => {
    const window = authorize(event)
    const request = parseNotification(value)
    const owner = ownerFor(window)
    close(owner, request.id)
    if (!Notification.isSupported()) return 'unsupported'
    try {
      const notice = new Notification({ title: request.title, body: request.body })
      owner.notices.set(request.id, notice)
      const current = notice
      // Windows banner timeout emits close while its Action Center entry remains actionable.
      // Retain the reminder until its question resolves or the owning document ends.
      current.once('failed', () => {
        if (owner.notices.get(request.id) !== current) return
        owner.notices.delete(request.id)
        current.removeAllListeners()
        send(window, { type: 'failed', id: request.id })
      })
      current.once('click', () => {
        if (owner.notices.get(request.id) !== current) return
        try { close(owner, request.id) }
        catch (error) { console.error('Desktop question notification withdrawal failed', error) }
        try {
          if (window.isDestroyed()) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          send(window, { type: 'activated', id: request.id })
        } catch (error) {
          console.error('Desktop question notification activation failed', error)
          send(window, { type: 'failed', id: request.id })
        }
      })
      current.show()
      return 'submitted'
    } catch (error) {
      console.error('Desktop question notification submission failed', error)
      try { close(owner, request.id) }
      catch (cleanupError) { console.error('Desktop question notification cleanup failed', cleanupError) }
      return 'failed'
    }
  })
  ipcMain.handle(DESKTOP_IPC.questionNotificationClose, (event, value: unknown) => {
    const window = authorize(event)
    const id = parseId(value)
    const owner = owners.get(window)
    if (owner !== undefined) close(owner, id)
  })
  return () => {
    ipcMain.removeHandler(DESKTOP_IPC.questionNotificationShow)
    ipcMain.removeHandler(DESKTOP_IPC.questionNotificationClose)
    for (const window of owners.keys()) release(window)
  }
}

function parseId(value: unknown): QuestionNotificationId {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid question notification id')
  return value as QuestionNotificationId
}

function parseNotification(value: unknown): DesktopQuestionNotification {
  if (typeof value !== 'object' || value === null
    || !('id' in value) || !('title' in value) || typeof value.title !== 'string' || value.title.length === 0
    || !('body' in value) || typeof value.body !== 'string') throw new TypeError('Invalid question notification')
  return { id: parseId(value.id), title: value.title, body: value.body }
}
