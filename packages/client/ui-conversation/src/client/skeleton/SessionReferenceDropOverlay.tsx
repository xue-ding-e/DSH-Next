/** Main-content feedback for dragging a conversation into the active draft. */
import { createPortal } from 'react-dom'
import type { SessionDropArea } from './session-reference-drop.ts'
import css from './SessionReferenceDropOverlay.module.css'

/**
 * Show the receiving region without intercepting native drag events below it.
 * @param props - measured content bounds and localized release hint.
 * @returns a body portal that escapes transformed and clipped composer ancestors.
 */
export function SessionReferenceDropOverlay({ area, label }: { readonly area: SessionDropArea; readonly label: string }) {
  return createPortal(
    <div className={css.mask} style={area} role="status" data-session-reference-drop>
      <span className={css.hint}>{label}</span>
    </div>, document.body,
  )
}
