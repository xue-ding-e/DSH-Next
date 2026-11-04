/** Session navigation observes native pointer selection without taking over editor input. */
import { $getNearestNodeFromDOMNode, $getSelection, $isRangeSelection } from 'lexical'
import type { LexicalEditor } from 'lexical'
import type { SessionReferenceNavigation } from '../../../reference-navigation-settings.ts'
import { ReferenceGesture } from '../../reference-gesture.ts'
import { $isReferenceChipNode } from './chip-node.tsx'

/**
 * Route configured Session-chip gestures separately from file and skill previews.
 * @param editor - the Session's composer.
 * @param preference - current shared settings projection.
 * @param open - navigation action retaining the source draft.
 * @returns root-listener and pointer-listener disposer.
 */
export function registerSessionReferenceActivation(
  editor: LexicalEditor,
  preference: () => Readonly<SessionReferenceNavigation>,
  open: (reference: string) => void,
): () => void {
  const gesture = new ReferenceGesture()
  let detach = (): void => {}
  const off = editor.registerRootListener((root) => {
    detach()
    gesture.cancel()
    if (root === null) return
    const referenceAt = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return undefined
      const element = target.closest<HTMLElement>('[data-composer-chip]')
      if (element === null || !root.contains(element)) return undefined
      // DOM-node lookup needs the active editor as well as its current state.
      return editor.read(() => {
        const node = $getNearestNodeFromDOMNode(element)
        if (!$isReferenceChipNode(node) || node.getAppearance() !== 'session' || node.isInvalid()) return undefined
        return { element, ref: node.getReference() }
      })
    }
    const hasSelection = (): boolean => root.ownerDocument.getSelection()?.isCollapsed === false
      || editor.getEditorState().read(() => {
        const selection = $getSelection()
        return $isRangeSelection(selection) && !selection.isCollapsed()
      })
    const down = (event: MouseEvent): void => {
      const reference = referenceAt(event.target)
      if (reference === undefined) { gesture.cancel(); return }
      if (gesture.begin(event, reference.element, preference(), hasSelection()) && event.detail === 2) event.preventDefault()
    }
    const click = (event: MouseEvent): void => {
      const reference = referenceAt(event.target)
      if (reference === undefined || !gesture.finish(event, reference.element, preference(), hasSelection())) return
      event.preventDefault()
      event.stopPropagation()
      open(reference.ref)
    }
    const move = (event: PointerEvent): void => { gesture.move(event) }
    const cancel = (): void => { gesture.cancel() }
    root.addEventListener('mousedown', down, true)
    root.addEventListener('pointermove', move, true)
    root.addEventListener('pointerleave', cancel)
    root.addEventListener('pointercancel', cancel)
    root.addEventListener('dragstart', cancel, true)
    root.addEventListener('click', click, true)
    root.ownerDocument.defaultView?.addEventListener('blur', cancel)
    detach = () => {
      root.removeEventListener('mousedown', down, true)
      root.removeEventListener('pointermove', move, true)
      root.removeEventListener('pointerleave', cancel)
      root.removeEventListener('pointercancel', cancel)
      root.removeEventListener('dragstart', cancel, true)
      root.removeEventListener('click', click, true)
      root.ownerDocument.defaultView?.removeEventListener('blur', cancel)
    }
  })
  return () => { off(); detach(); gesture.cancel() }
}
