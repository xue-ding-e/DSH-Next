// @vitest-environment jsdom
/** Native mouse events must bind Lexical's editor only after hitting an atomic Session reference. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import { registerSessionReferenceActivation } from '../src/client/input/editor/session-reference-activation.ts'
import { DEFAULT_SESSION_REFERENCE_NAVIGATION as DEFAULT } from '../src/reference-navigation-settings.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const off of cleanups.splice(0).reverse()) off() })

function bench() {
  const editor = createEditor({ nodes: [ReferenceChipNode], onError: (error) => { throw error } })
  const root = document.createElement('div')
  root.contentEditable = 'true'
  document.body.append(root)
  editor.setRootElement(root)
  cleanups.push(() => { editor.setRootElement(null); root.remove() })
  let session!: ReferenceChipNode
  let file!: ReferenceChipNode
  editor.update(() => {
    session = new ReferenceChipNode({ source: 'reference', ref: 'session-token', label: 'Session', appearance: 'session', clipboardText: '@session' })
    file = new ReferenceChipNode({ source: 'reference', ref: '@a.md', label: 'a.md', appearance: 'file', clipboardText: '@a.md' })
    $getRoot().append($createParagraphNode().append($createTextNode('ordinary '), session, $createTextNode(' '), file))
  }, { discrete: true })
  let preference = DEFAULT
  const open = vi.fn<(reference: string) => void>()
  const off = registerSessionReferenceActivation(editor, () => preference, open)
  cleanups.push(off)
  const press = (target: Element, detail = 1, modifiers: MouseEventInit = {}) => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail, ...modifiers }))
  }
  const release = (target: Element, detail = 1, modifiers: MouseEventInit = {}) => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail, ...modifiers }))
  }
  const host = () => editor.getElementByKey(session.getKey())!
  return { editor, root, session, file, open, off, press, release, host,
    setPreference: (next: typeof DEFAULT) => { preference = next } }
}

describe('composer Session reference activation', () => {
  it('returns from ordinary mouse clicks before reading Lexical and resolves nested chip DOM with its active editor', () => {
    const b = bench()
    const read = vi.spyOn(b.editor, 'read')
    cleanups.push(() => { read.mockRestore() })
    b.press(b.root)
    b.release(b.root)
    const ordinary = b.root.querySelector('[data-lexical-text]')!
    b.press(ordinary)
    b.release(ordinary)
    expect(read).not.toHaveBeenCalled()
    expect(b.open).not.toHaveBeenCalled()
    const label = document.createElement('span')
    b.host().append(label)
    b.press(label)
    b.release(label)
    expect(b.open).toHaveBeenCalledExactlyOnceWith('session-token')
    expect(b.editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('ordinary @session @a.md')
  })

  it('respects live double-click and Ctrl or Meta preferences while leaving file chips to their owner', () => {
    const b = bench()
    b.setPreference({ ...DEFAULT, gesture: 'double-click' })
    b.press(b.host())
    b.release(b.host())
    expect(b.open).not.toHaveBeenCalled()
    b.press(b.host(), 2)
    b.release(b.host(), 2)
    expect(b.open).toHaveBeenCalledTimes(1)
    b.setPreference({ ...DEFAULT, gesture: 'modifier-click' })
    b.press(b.host(), 1, { ctrlKey: true })
    b.release(b.host(), 1, { ctrlKey: true })
    b.press(b.host(), 1, { metaKey: true })
    b.release(b.host(), 1, { metaKey: true })
    const file = b.editor.getElementByKey(b.file.getKey())!
    b.press(file, 1, { ctrlKey: true })
    b.release(file, 1, { ctrlKey: true })
    expect(b.open).toHaveBeenCalledTimes(3)
  })

  it('cancels a drag, invalid reference, and disposed listener without affecting the draft', () => {
    const b = bench()
    b.press(b.host())
    b.root.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1 }))
    b.release(b.host())
    expect(b.open).not.toHaveBeenCalled()
    b.editor.update(() => { b.session.setInvalid(true) }, { discrete: true })
    b.press(b.host())
    b.release(b.host())
    expect(b.open).not.toHaveBeenCalled()
    b.off()
    b.editor.update(() => { b.session.setInvalid(false) }, { discrete: true })
    b.press(b.host())
    b.release(b.host())
    expect(b.open).not.toHaveBeenCalled()
  })
})
