// @vitest-environment jsdom
/** Reference selection paints the atomic host while keeping editor content and selection authoritative. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  $createNodeSelection, $createParagraphNode, $createRangeSelection, $createTextNode,
  $getRoot, $setSelection, createEditor,
} from 'lexical'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import { registerReferenceSelection } from '../src/client/input/editor/reference-selection.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const off of cleanups.splice(0).reverse()) off() })

function bench() {
  const editor = createEditor({ nodes: [ReferenceChipNode], onError: (error) => { throw error } })
  const root = document.createElement('div')
  root.contentEditable = 'true'
  document.body.append(root)
  editor.setRootElement(root)
  cleanups.push(() => { editor.setRootElement(null); root.remove() })
  const off = registerReferenceSelection(editor)
  cleanups.push(off)
  let paragraphKey = ''
  let firstKey = ''
  let secondKey = ''
  editor.update(() => {
    const first = new ReferenceChipNode({ source: 'reference', ref: 'one', label: 'One', appearance: 'session', clipboardText: '@one' })
    const second = new ReferenceChipNode({ source: 'reference', ref: 'two', label: 'Two', appearance: 'session', clipboardText: '@two' })
    const paragraph = $createParagraphNode().append($createTextNode('before '), first, $createTextNode(' between '), second, $createTextNode(' after'))
    $getRoot().append(paragraph)
    paragraphKey = paragraph.getKey()
    firstKey = first.getKey()
    secondKey = second.getKey()
  }, { discrete: true })
  const selected = () => [firstKey, secondKey].map(key => editor.getElementByKey(key)!.hasAttribute('data-selected'))
  const range = (start: number, end: number) => { editor.update(() => {
    const selection = $createRangeSelection()
    selection.anchor.set(paragraphKey, start, 'element')
    selection.focus.set(paragraphKey, end, 'element')
    $setSelection(selection)
  }, { discrete: true }) }
  return { editor, firstKey, secondKey, selected, range, off }
}

describe('atomic reference selection', () => {
  it('covers one chip, ranges in both directions, and select-all without serializing presentation', () => {
    const { editor, selected, range } = bench()
    range(1, 2)
    expect(selected()).toEqual([true, false])
    range(0, 5)
    expect(selected()).toEqual([true, true])
    range(4, 1)
    expect(selected()).toEqual([true, true])
    range(2, 2)
    expect(selected()).toEqual([false, false])
    const contents = editor.getEditorState().read(() => $getRoot().getTextContent())
    expect(contents).toBe('before @one between @two after')
    expect(JSON.stringify(editor.getEditorState())).not.toContain('data-selected')
  })

  it('paints node selections and releases the presentation with its listener', () => {
    const { editor, firstKey, selected, off } = bench()
    editor.update(() => {
      const selection = $createNodeSelection()
      selection.add(firstKey)
      $setSelection(selection)
    }, { discrete: true })
    expect(selected()).toEqual([true, false])
    off()
    expect(selected()).toEqual([false, false])
  })
})
