// @vitest-environment jsdom
/** Conversation drops follow the receiving frame rather than only its text field. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SESSION_REFERENCE_DRAG_TYPE } from '../src/client/contract/draft-editor.ts'
import { installSessionReferenceDrop } from '../src/client/skeleton/session-reference-drop.ts'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

function fixture() {
  const frame = document.createElement('div')
  frame.dataset.appFrame = ''
  const sidebar = document.createElement('aside')
  const main = document.createElement('main')
  main.dataset.mainColumn = ''
  const content = document.createElement('section')
  content.dataset.conversationContent = ''
  const card = document.createElement('div')
  const right = document.createElement('aside')
  right.dataset.rightbarCol = ''
  main.append(content, card)
  frame.append(sidebar, main, right)
  document.body.append(frame)
  vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 30, 700, 770))
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 95, 700, 705))
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 30, 1200, 770))
  const insert = vi.fn(() => true)
  const show = vi.fn()
  let permitted = true
  const release = installSessionReferenceDrop(card, {
    sessionId: SessionId('target'), canAccept: () => permitted, insert, show,
  })
  const data = {
    types: [SESSION_REFERENCE_DRAG_TYPE], dropEffect: 'none',
    getData: () => JSON.stringify({ sessionId: 'source', label: 'Source', mention: '@[Source](dsh-session:InNvdXJjZSI)' }),
  }
  const dispatch = (target: Element, type: string, extra: Record<string, unknown> = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, Object.fromEntries(Object.entries({ dataTransfer: data, relatedTarget: null,
      clientX: 500, clientY: 400, ...extra }).map(([key, value]) => [key, { value }])))
    target.dispatchEvent(event)
    return event
  }
  return { main, content, card, right, sidebar, data, insert, show, dispatch, release, deny: () => { permitted = false } }
}

describe('conversation reference drop area', () => {
  it.each(['content', 'right', 'card'] as const)('accepts a drop on %s with one main-composer insertion', (destination) => {
    const f = fixture()
    try {
      expect(f.dispatch(f[destination], 'dragenter').defaultPrevented).toBe(true)
      expect(f.show).toHaveBeenLastCalledWith({ left: 280, top: 95, width: 920, height: 705 })
      expect(f.data.dropEffect).toBe('copy')
      expect(f.dispatch(f[destination], 'drop').defaultPrevented).toBe(true)
      expect(f.insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ appearance: 'session', label: 'Source' }))
      expect(f.show).toHaveBeenLastCalledWith(null)
      expect(f.data.dropEffect).toBe('copy')
    } finally { f.release() }
  })

  it('clears feedback on returning to the sidebar and lets sidebar drops keep their ordering behavior', () => {
    const f = fixture()
    try {
      f.dispatch(f.content, 'dragenter')
      expect(f.dispatch(f.sidebar, 'dragover').defaultPrevented).toBe(false)
      expect(f.show).toHaveBeenLastCalledWith(null)
      expect(f.dispatch(f.sidebar, 'drop').defaultPrevented).toBe(false)
      expect(f.insert).not.toHaveBeenCalled()
    } finally { f.release() }
  })

  it('keeps feedback while crossing nested content and removes it after Escape or leaving the window', () => {
    const f = fixture()
    try {
      f.dispatch(f.content, 'dragenter')
      f.dispatch(f.content, 'dragleave')
      expect(f.show).toHaveBeenCalledTimes(1)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(f.show).toHaveBeenLastCalledWith(null)
      f.dispatch(f.content, 'dragover')
      f.dispatch(f.content, 'dragleave', { clientX: 0, clientY: 0 })
      expect(f.show).toHaveBeenLastCalledWith(null)
    } finally { f.release() }
  })

  it('rejects permission changes and modal drops without touching the draft', () => {
    const f = fixture()
    try {
      f.dispatch(f.content, 'dragenter')
      f.deny()
      f.dispatch(f.content, 'dragover')
      expect(f.data.dropEffect).toBe('none')
      expect(f.show).toHaveBeenLastCalledWith(null)
      f.dispatch(f.content, 'drop')
      expect(f.insert).not.toHaveBeenCalled()
      const dialog = document.createElement('div')
      dialog.role = 'dialog'
      f.main.append(dialog)
      expect(f.dispatch(dialog, 'drop').defaultPrevented).toBe(false)
    } finally { f.release() }
  })

  it('leaves file transfers to attachment intake and releases document listeners on disposal', () => {
    const f = fixture()
    expect(f.dispatch(f.content, 'dragover', { dataTransfer: { types: ['Files'] } }).defaultPrevented).toBe(false)
    f.dispatch(f.content, 'dragenter')
    f.release()
    expect(f.show).toHaveBeenLastCalledWith(null)
    f.show.mockClear()
    expect(f.dispatch(f.content, 'drop').defaultPrevented).toBe(false)
    expect(f.insert).not.toHaveBeenCalled()
    expect(f.show).not.toHaveBeenCalled()
  })

  it('does not let a right-panel composer insert the same reference a second time', () => {
    const f = fixture()
    const card = document.createElement('div')
    f.right.append(card)
    const insert = vi.fn(() => true)
    const release = installSessionReferenceDrop(card, { sessionId: SessionId('embedded'), canAccept: () => true, insert, show: vi.fn() })
    try {
      f.dispatch(card, 'drop')
      expect(f.insert).toHaveBeenCalledTimes(1)
      expect(insert).not.toHaveBeenCalled()
    } finally { release(); f.release() }
  })
})
