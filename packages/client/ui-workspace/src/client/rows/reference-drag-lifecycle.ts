/** Source-row lifecycle only; reference tokens and authorization remain with their owners. */
import { useCallback, useEffect, useRef } from 'react'

/** Retain the start's local handle across prop changes and browser event wrappers. */
export function useReferenceDragLifecycle() {
  const active = useRef<(() => boolean) | undefined>(undefined)
  const end = useCallback(() => {
    const finish = active.current
    active.current = undefined
    return { current: finish !== undefined, consumed: finish?.() ?? false }
  }, [])
  const start = useCallback((begin: () => (() => boolean) | undefined) => {
    // Native drags are sequential. A replacement start still disposes its
    // interrupted handle; the owner guards that handle against newer generations.
    end()
    active.current = begin() ?? (() => false)
  }, [end])
  useEffect(() => () => { end() }, [end])
  return { start, end }
}
