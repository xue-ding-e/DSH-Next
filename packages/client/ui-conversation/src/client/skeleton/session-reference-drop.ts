/** Native conversation drops owned by one mounted composer. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference/uri'
import { SESSION_REFERENCE_DRAG_TYPE, type ReferenceInsert } from '../contract/draft-editor.ts'

/** Viewport coordinates of the receiving conversation and its right panel. */
export interface SessionDropArea {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function referencePayload(value: string): { sessionId: string; reference: ReferenceInsert } | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null
      || !('sessionId' in parsed) || !('label' in parsed) || !('mention' in parsed)) return undefined
    const { sessionId, label, mention } = parsed
    if (typeof sessionId !== 'string' || sessionId === '' || typeof label !== 'string' || label === ''
      || typeof mention !== 'string'
      || mention !== formatSessionReferenceMention({ sessionId: brandString<SessionId>(sessionId), label })) return undefined
    return { sessionId, reference: { source: 'reference', ref: mention, label, appearance: 'session', clipboardText: mention } }
  } catch (_error: unknown) {
    // Foreign drag data cannot interrupt a draft.
    return undefined
  }
}

/**
 * Accept references throughout the main content and right panel; standalone composers keep their card target.
 * @param card - mounted composer card identifying the receiving frame.
 * @param options - current permissions, Session identity, insertion and visual feedback.
 * @returns cleanup for this composer's native event listeners.
 */
export function installSessionReferenceDrop(card: HTMLElement, options: {
  readonly canAccept: () => boolean
  readonly sessionId: SessionId | undefined
  readonly insert: (reference: ReferenceInsert) => boolean
  readonly show: (area: SessionDropArea | null) => void
}): () => void {
  const document = card.ownerDocument
  const view = document.defaultView
  const main = card.closest<HTMLElement>('[data-main-column]')
  const frame = card.closest<HTMLElement>('[data-app-frame]')
  // A right-panel composer must not also consume the main composer's drop.
  if (main === null && frame !== null) return () => {}
  let active = false
  let area: SessionDropArea | null = null
  const reset = (): void => { active = false; area = null; options.show(null) }
  const acceptsTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element) || target.closest('[role="dialog"], [aria-modal="true"]') !== null) return false
    if (main === null || frame === null) return card.contains(target)
    const region = target.closest('[data-main-column], [data-rightbar-col]')
    return region !== null && frame.contains(region)
  }
  const transfer = (event: DragEvent): DataTransfer | null => event.dataTransfer !== null
    && Array.from(event.dataTransfer.types).includes(SESSION_REFERENCE_DRAG_TYPE) ? event.dataTransfer : null
  const over = (event: DragEvent): void => {
    const data = transfer(event)
    if (data === null) return
    if (!acceptsTarget(event.target)) { if (active) reset(); return }
    event.preventDefault()
    event.stopPropagation()
    data.dropEffect = options.canAccept() ? 'copy' : 'none'
    if (data.dropEffect === 'none') { if (active) reset(); return }
    if (active) return
    active = true
    const bounds = (main ?? card).getBoundingClientRect()
    const content = main?.querySelector('[data-conversation-content]')?.getBoundingClientRect()
    const top = content?.top ?? bounds.top
    area = { left: bounds.left, top, width: (frame?.getBoundingClientRect().right ?? bounds.right) - bounds.left,
      height: Math.max(0, bounds.bottom - top) }
    options.show(area)
  }
  const leave = (event: DragEvent): void => {
    if (transfer(event) === null || !active) return
    if (event.relatedTarget !== null) { if (!acceptsTarget(event.relatedTarget)) reset(); return }
    if (area !== null && (event.clientX <= area.left || event.clientY <= area.top
      || event.clientX >= area.left + area.width || event.clientY >= area.top + area.height)) reset()
  }
  const drop = (event: DragEvent): void => {
    const data = transfer(event)
    if (data === null) return
    reset()
    if (!acceptsTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    data.dropEffect = 'none'
    if (!options.canAccept()) return
    const payload = referencePayload(data.getData(SESSION_REFERENCE_DRAG_TYPE))
    if (payload === undefined || payload.sessionId === options.sessionId) return
    if (options.insert(payload.reference)) data.dropEffect = 'copy'
  }
  const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') reset() }
  document.addEventListener('dragenter', over, true)
  document.addEventListener('dragover', over, true)
  document.addEventListener('dragleave', leave)
  document.addEventListener('drop', drop, true)
  document.addEventListener('keydown', key)
  view?.addEventListener('dragend', reset)
  view?.addEventListener('blur', reset)
  view?.addEventListener('resize', reset)
  return () => {
    if (active) reset()
    document.removeEventListener('dragenter', over, true)
    document.removeEventListener('dragover', over, true)
    document.removeEventListener('dragleave', leave)
    document.removeEventListener('drop', drop, true)
    document.removeEventListener('keydown', key)
    view?.removeEventListener('dragend', reset)
    view?.removeEventListener('blur', reset)
    view?.removeEventListener('resize', reset)
  }
}
