/** Gesture matching and pointer lifetime are independent of browser timing and native selection. */
import { describe, expect, it } from 'vitest'
import { matchesReferenceGesture, ReferenceGesture } from '../src/client/reference-gesture.ts'
import { DEFAULT_SESSION_REFERENCE_NAVIGATION as DEFAULT } from '../src/reference-navigation-settings.ts'

type Event = Parameters<typeof matchesReferenceGesture>[0]
const click = (overrides: Partial<Event> = {}): Event => ({
  button: 0, detail: 1, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, clientX: 20, clientY: 30, ...overrides,
})

describe('Session reference gestures', () => {
  it('uses immediate single clicks by default and exact click counts for double clicks', () => {
    expect(matchesReferenceGesture(click(), DEFAULT)).toBe(true)
    expect(matchesReferenceGesture(click({ detail: 2 }), DEFAULT)).toBe(false)
    expect(matchesReferenceGesture(click({ button: 1 }), DEFAULT)).toBe(false)
    expect(matchesReferenceGesture(click({ ctrlKey: true }), DEFAULT)).toBe(false)
    const double = { ...DEFAULT, gesture: 'double-click' as const }
    expect(matchesReferenceGesture(click(), double)).toBe(false)
    expect(matchesReferenceGesture(click({ detail: 2 }), double)).toBe(true)
    expect(matchesReferenceGesture(click({ detail: 3 }), double)).toBe(false)
  })

  it('accepts Ctrl or Meta for the portable preset and rejects extra modifiers', () => {
    const primary = { ...DEFAULT, gesture: 'modifier-click' as const }
    expect(matchesReferenceGesture(click({ ctrlKey: true }), primary)).toBe(true)
    expect(matchesReferenceGesture(click({ metaKey: true }), primary)).toBe(true)
    expect(matchesReferenceGesture(click(), primary)).toBe(false)
    expect(matchesReferenceGesture(click({ ctrlKey: true, metaKey: true }), primary)).toBe(false)
    expect(matchesReferenceGesture(click({ ctrlKey: true, altKey: true }), primary)).toBe(false)
    expect(matchesReferenceGesture(click({ metaKey: true, shiftKey: true }), primary)).toBe(false)
  })

  it('requires every custom modifier, with no additional modifiers', () => {
    const custom = { ...DEFAULT, gesture: 'custom' as const, clicks: 'double' as const, control: true, meta: true, alt: true, shift: true }
    const event = click({ detail: 2, ctrlKey: true, metaKey: true, altKey: true, shiftKey: true })
    expect(matchesReferenceGesture(event, custom)).toBe(true)
    for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(matchesReferenceGesture({ ...event, [key]: false }, custom)).toBe(false)
    }
    expect(matchesReferenceGesture({ ...event, detail: 1 }, custom)).toBe(false)
  })

  it('cancels movement even when the pointer returns, selection, replacement targets, and blur', () => {
    const gesture = new ReferenceGesture()
    const target = {}
    gesture.begin(click(), target, DEFAULT, false)
    gesture.move(click({ clientX: 21 }))
    gesture.move(click())
    expect(gesture.finish(click(), target, DEFAULT, false)).toBe(false)
    expect(gesture.begin(click(), target, DEFAULT, true)).toBe(false)
    expect(gesture.finish(click(), target, DEFAULT, false)).toBe(false)
    gesture.begin(click(), target, DEFAULT, false)
    expect(gesture.finish(click(), target, DEFAULT, true)).toBe(false)
    gesture.begin(click(), target, DEFAULT, false)
    expect(gesture.finish(click(), {}, DEFAULT, false)).toBe(false)
    gesture.begin(click(), target, DEFAULT, false)
    gesture.cancel()
    expect(gesture.finish(click(), target, DEFAULT, false)).toBe(false)
  })

  it('rejects modifiers pressed after mouse-down and settings changed during a press', () => {
    const gesture = new ReferenceGesture()
    const target = {}
    const primary = { ...DEFAULT, gesture: 'modifier-click' as const }
    gesture.begin(click(), target, primary, false)
    expect(gesture.finish(click({ ctrlKey: true }), target, primary, false)).toBe(false)
    gesture.begin(click(), target, DEFAULT, false)
    expect(gesture.finish(click({ ctrlKey: true }), target, primary, false)).toBe(false)
    gesture.begin(click(), target, DEFAULT, false)
    expect(gesture.finish(click(), target, DEFAULT, false)).toBe(true)
    expect(gesture.finish(click(), target, DEFAULT, false)).toBe(false)
  })
})
