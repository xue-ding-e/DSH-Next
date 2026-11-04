// @vitest-environment jsdom
/** Pending recall focus is owned by the Session shell independently of root detachment. */
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionInputShell } from '../src/client/input/facade.ts'

async function pendingFocus() {
  const settled = Promise.withResolvers<undefined>()
  const shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: async () => ({ kind: 'success' }),
    canRecallQueue: () => true,
    recallQueue: async () => ({ text: 'recalled draft', attachmentIds: [], commit: () => {} }),
    retainRecall: () => () => { settled.resolve(undefined) },
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  const { editor } = shell
  const root = document.createElement('div')
  root.contentEditable = 'true'
  root.tabIndex = 0
  document.body.append(root)
  const setRoot = editor.setRootElement.bind(editor)
  setRoot(root)
  const offEditable = vi.fn()
  const offRoot = vi.fn()
  const registerEditable = editor.registerEditableListener.bind(editor)
  const registerRoot = editor.registerRootListener.bind(editor)
  const editableSpy = vi.spyOn(editor, 'registerEditableListener').mockImplementation((listener) => {
    const off = registerEditable(listener)
    return () => { offEditable(); off() }
  })
  const rootSpy = vi.spyOn(editor, 'registerRootListener').mockImplementation((listener) => {
    const off = registerRoot(listener)
    return () => { offRoot(); off() }
  })
  onTestFinished(() => {
    shell.dispose()
    setRoot(null)
    root.remove()
    editableSpy.mockRestore()
    rootSpy.mockRestore()
  })
  root.focus()
  expect(shell.recallQueue()).toBe(true)
  editor.setEditable(false)
  await settled.promise
  expect(shell.snapshot.phase).toBe('plain')
  expect(editor.isEditable()).toBe(false)
  expect(offEditable).not.toHaveBeenCalled()
  expect(offRoot).not.toHaveBeenCalled()
  return { shell, editor, root, offEditable, offRoot }
}

it('releases both listeners on disposal while the read-only root remains attached', async () => {
  const f = await pendingFocus()
  // Root detachment normally supplies a second cleanup path; withhold it so
  // this case observes the shell's ownership of the pending subscriptions.
  const keepRoot = vi.spyOn(f.editor, 'setRootElement').mockImplementation(() => {})
  try {
    f.shell.dispose()
    expect(f.editor.getRootElement()).toBe(f.root)
    expect(f.root.isConnected).toBe(true)
    expect(f.editor.isEditable()).toBe(false)
    expect(f.offEditable).toHaveBeenCalledOnce()
    expect(f.offRoot).toHaveBeenCalledOnce()
    f.shell.dispose()
    expect(f.offEditable).toHaveBeenCalledOnce()
    expect(f.offRoot).toHaveBeenCalledOnce()
  } finally {
    keepRoot.mockRestore()
  }
})

it('cancels deferred focus when disposal follows re-enabling in the same task', async () => {
  const f = await pendingFocus()
  const focus = vi.spyOn(f.root, 'focus')
  onTestFinished(() => { focus.mockRestore() })
  f.editor.setEditable(true)
  f.shell.dispose()
  await Promise.resolve()
  expect(focus).not.toHaveBeenCalled()
  expect(f.offEditable).toHaveBeenCalledOnce()
  expect(f.offRoot).toHaveBeenCalledOnce()
})

it('persists a recalled draft through the initiating writer after its view unmounts', async () => {
  const reply = Promise.withResolvers<{ text: string; attachmentIds: []; commit(): void }>()
  const settled = Promise.withResolvers<undefined>()
  const write = vi.fn()
  const commit = vi.fn(() => {
    expect(write).toHaveBeenLastCalledWith({ text: 'restored after navigation', references: [] })
  })
  const shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: async () => ({ kind: 'success' }),
    canRecallQueue: () => true,
    recallQueue: () => reply.promise,
    retainRecall: () => () => { settled.resolve(undefined) },
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  onTestFinished(() => { shell.dispose() })
  const unbind = shell.bindDraftPersistence(write)
  expect(shell.recallQueue()).toBe(true)
  unbind()
  reply.resolve({ text: 'restored after navigation', attachmentIds: [], commit })
  await settled.promise
  expect(shell.snapshot.draft).toBe('restored after navigation')
  expect(commit).toHaveBeenCalledOnce()
})
