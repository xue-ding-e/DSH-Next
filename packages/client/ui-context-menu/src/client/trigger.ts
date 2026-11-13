/** DOM gesture bindings owned by one menu plugin instance. */
import type { SyntheticEvent } from 'react'
import type { ContextMenuTriggerProps, MenuPoint, ContextMenuTarget } from './types.ts'

/**
 * Create stable bindings for the plugin's injected hook.
 * @param open - Open against the supplied captured target and viewport position.
 * @param active - Whether the plugin still owns its service.
 * @returns Ordinary trigger-prop factory; no React subscription or context is created.
 */
export function createContextMenuBindings<Target extends object = ContextMenuTarget>(
  open: (target: Target, point: MenuPoint) => void, active: () => boolean,
): { getTriggerProps: (target: Target | (() => Target) | undefined, handlers?: ContextMenuTriggerProps) => ContextMenuTriggerProps } {
  const keyboardAnchors = new WeakMap<HTMLElement, number>()
  return {
    getTriggerProps(target, handlers = {}) {
      if (target === undefined) return handlers
      const show = (event: SyntheticEvent<HTMLElement>, x: number, y: number): void => {
        if (event.defaultPrevented || !active()) return
        const captured = typeof target === 'function' ? target() : target
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        open(captured, { x, y })
      }
      return {
        ...handlers,
        tabIndex: handlers.tabIndex ?? 0,
        onContextMenu(event) {
          handlers.onContextMenu?.(event)
          // Keyboard context-menu events can carry the focused element's center in Chromium.
          const keyboard = event.button === -1 || (event.clientX === 0 && event.clientY === 0)
          const handledAt = keyboardAnchors.get(event.currentTarget)
          keyboardAnchors.delete(event.currentTarget)
          if (event.button === -1 && handledAt !== undefined && event.timeStamp - handledAt < 100) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          const rect = keyboard ? event.currentTarget.getBoundingClientRect() : undefined
          show(event, rect?.left ?? event.clientX, rect?.bottom ?? event.clientY)
        },
        onKeyDown(event) {
          handlers.onKeyDown?.(event)
          if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey
            || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
          const rect = event.currentTarget.getBoundingClientRect()
          if (active()) keyboardAnchors.set(event.currentTarget, event.timeStamp)
          show(event, rect.left, rect.bottom)
        },
      }
    },
  }
}
