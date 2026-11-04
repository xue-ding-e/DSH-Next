/** Host-owned pointer preferences shared by sent and draft Session references. */
import z from '@deepseek-ai/schemastery'

/** Required click count and exact modifiers for a custom left-button gesture. */
export interface SessionReferenceNavigation {
  /** Presets use their own modifiers and click count; custom uses the remaining fields. */
  gesture: 'click' | 'double-click' | 'modifier-click' | 'custom'
  clicks: 'single' | 'double'
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/** New and existing settings documents open Session references with an ordinary click. */
export const DEFAULT_SESSION_REFERENCE_NAVIGATION: Readonly<SessionReferenceNavigation> = {
  gesture: 'click', clicks: 'single', control: false, meta: false, alt: false, shift: false,
}

/** Validated live setting; missing fields inherit the ordinary-click preset. */
export const SessionReferenceNavigationSchema = z.object({
  gesture: z.union(['click', 'double-click', 'modifier-click', 'custom']).default('click'),
  clicks: z.union(['single', 'double']).default('single'),
  control: z.boolean().default(false),
  meta: z.boolean().default(false),
  alt: z.boolean().default(false),
  shift: z.boolean().default(false),
}).default(DEFAULT_SESSION_REFERENCE_NAVIGATION)
