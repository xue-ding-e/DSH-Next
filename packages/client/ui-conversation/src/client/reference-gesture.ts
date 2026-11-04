/** Left-button navigation requires one stationary press with its modifiers already held. */
import type { SessionReferenceNavigation } from '../reference-navigation-settings.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'

type GestureEvent = Pick<MouseEvent, 'button' | 'detail' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'clientX' | 'clientY'>

/**
 * Match an exact gesture, excluding unrequested modifiers and repeated clicks.
 * @param event - the current pointer event.
 * @param preference - the live Host preference.
 * @returns whether the event has the configured button, count, and modifiers.
 */
export function matchesReferenceGesture(event: GestureEvent, preference: Readonly<SessionReferenceNavigation>): boolean {
  const { gesture } = preference
  if (event.button !== 0) return false
  switch (gesture) {
    case 'click':
    case 'double-click':
      return event.detail === (gesture === 'click' ? 1 : 2)
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    case 'modifier-click':
      return event.detail === 1 && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey
    case 'custom':
      return event.detail === (preference.clicks === 'double' ? 2 : 1)
        && event.ctrlKey === preference.control && event.metaKey === preference.meta
        && event.altKey === preference.alt && event.shiftKey === preference.shift
    default:
      return assertNever(gesture)
  }
}

/** Per-surface pointer state; no timer delays ordinary single-click navigation. */
export class ReferenceGesture {
  private press: { readonly target: object; readonly x: number; readonly y: number; readonly preference: string } | undefined

  /**
   * Capture the target and modifiers before native focus or selection changes.
   * @param event - pointer-down event.
   * @param target - the atomic reference identity under the pointer.
   * @param preference - preference at press time.
   * @param hasSelection - whether text was selected before the press.
   * @returns whether the press can start navigation.
   */
  begin(event: GestureEvent, target: object, preference: Readonly<SessionReferenceNavigation>, hasSelection: boolean): boolean {
    this.cancel()
    if (hasSelection || !matchesReferenceGesture(event, preference)) return false
    this.press = { target, x: event.clientX, y: event.clientY, preference: JSON.stringify(preference) }
    return true
  }

  /**
   * Cancel once the pointer moves, even if it later returns to the reference.
   * @param event - pointer-move coordinates.
   */
  move(event: Pick<MouseEvent, 'clientX' | 'clientY'>): void {
    if (this.press !== undefined && (event.clientX !== this.press.x || event.clientY !== this.press.y)) this.cancel()
  }

  /** Forget a drag, cancellation, blur, or completed activation. */
  cancel(): void { this.press = undefined }

  /**
   * Finish the matching press without accepting late modifiers or a new selection.
   * @param event - click event after release.
   * @param target - the released reference identity.
   * @param preference - current preference, which must still match the press.
   * @param hasSelection - whether the gesture selected text.
   * @returns whether this click should navigate.
   */
  finish(event: GestureEvent, target: object, preference: Readonly<SessionReferenceNavigation>, hasSelection: boolean): boolean {
    const press = this.press
    this.cancel()
    return press !== undefined && press.target === target && !hasSelection
      && press.preference === JSON.stringify(preference) && matchesReferenceGesture(event, preference)
  }
}
