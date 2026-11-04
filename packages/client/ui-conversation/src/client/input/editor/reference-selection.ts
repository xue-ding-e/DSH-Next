/** Paint atomic references from Lexical selection without changing their serialized content. */
import { $getSelection, $isNodeSelection, $isRangeSelection } from 'lexical'
import type { LexicalEditor, NodeKey } from 'lexical'
import { $isReferenceChipNode } from './chip-node.tsx'

/**
 * Keep full-chip selection visible for node, range, and select-all selections.
 * @param editor - the shell-owned composer.
 * @returns the listener disposer, which also clears presentation attributes.
 */
export function registerReferenceSelection(editor: LexicalEditor): () => void {
  let painted = new Set<NodeKey>()
  const paint = (next: Set<NodeKey>): void => {
    for (const key of painted) {
      if (!next.has(key)) editor.getElementByKey(key)?.removeAttribute('data-selected')
    }
    for (const key of next) editor.getElementByKey(key)?.setAttribute('data-selected', '')
    painted = next
  }
  const off = editor.registerUpdateListener(({ editorState }) => {
    const selected = editorState.read(() => {
      const selection = $getSelection()
      if (!$isNodeSelection(selection) && (!$isRangeSelection(selection) || selection.isCollapsed())) return []
      return selection.getNodes().filter($isReferenceChipNode).map(node => node.getKey())
    })
    paint(new Set(selected))
  })
  return () => { off(); paint(new Set()) }
}
