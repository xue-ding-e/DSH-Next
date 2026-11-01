/** Session-local composer listener; cleanup cancels pending discovery before any draft write. */
import { useEffect, useRef } from 'react'
import { SESSION_REFERENCE_DRAG } from './session-drag.ts'

export interface SessionReferenceDropInjected {
  readonly drop: (transfer: DataTransfer, signal: AbortSignal) => Promise<void>
}

export function SessionReferenceDrop({ drop }: SessionReferenceDropInjected) {
  const marker = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const card = marker.current?.closest('[data-composer-card]')
    if (card === null || card === undefined) return
    const controller = new AbortController()
    const accepts = (event: DragEvent): boolean => event.dataTransfer?.types.includes(SESSION_REFERENCE_DRAG) === true
    const over = (event: Event): void => {
      const drag = event as DragEvent
      if (!accepts(drag)) return
      drag.preventDefault()
      if (drag.dataTransfer !== null) drag.dataTransfer.dropEffect = 'copy'
    }
    const receive = (event: Event): void => {
      const drag = event as DragEvent
      if (!accepts(drag) || drag.dataTransfer === null) return
      drag.preventDefault()
      drag.stopPropagation()
      void drop(drag.dataTransfer, controller.signal)
    }
    card.addEventListener('dragover', over, true)
    card.addEventListener('drop', receive, true)
    return () => {
      controller.abort()
      card.removeEventListener('dragover', over, true)
      card.removeEventListener('drop', receive, true)
    }
  }, [drop])
  return <span ref={marker} hidden />
}
