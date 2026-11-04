/** Reference preferences use the existing Host form's acceptance, refusal, and recovery. */
import { describe, expect, it } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { ReferenceNavigationPreference } from '../src/client/reference-navigation-preference.ts'
import { DEFAULT_SESSION_REFERENCE_NAVIGATION as DEFAULT } from '../src/reference-navigation-settings.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'

describe('reference navigation preference', () => {
  it('adopts accepted values, shares writes with configForms, and unsubscribes on disposal', async () => {
    const host = stubConfigForm<ConversationSettings>()
    const preference = new ReferenceNavigationPreference(host.scope)
    expect(preference.state.getSnapshot()).toEqual(DEFAULT)
    const double = { ...DEFAULT, gesture: 'double-click' as const }
    await expect(preference.set(double)).resolves.toBe(true)
    expect(host.set).toHaveBeenCalledWith('sessionReferenceNavigation', double)
    host.publish({ status: 'ready', value: { busyEnter: 'queue', sessionReferenceNavigation: double }, revision: 1, writable: true })
    expect(preference.state.getSnapshot()).toEqual(double)
    preference.dispose()
    host.publish({ value: { busyEnter: 'queue', sessionReferenceNavigation: DEFAULT }, revision: 2 })
    expect(preference.state.getSnapshot()).toEqual(double)
  })

  it('keeps the accepted gesture when a write is refused or transport rejects', async () => {
    const host = stubConfigForm<ConversationSettings>()
    const preference = new ReferenceNavigationPreference(host.scope)
    host.set.mockResolvedValueOnce(false)
    await expect(preference.set({ ...DEFAULT, gesture: 'modifier-click' })).resolves.toBe(false)
    expect(preference.state.getSnapshot()).toEqual(DEFAULT)
    host.set.mockRejectedValueOnce(new Error('transport'))
    await expect(preference.set({ ...DEFAULT, gesture: 'double-click' })).rejects.toThrow('transport')
    expect(preference.state.getSnapshot()).toEqual(DEFAULT)
    preference.dispose()
  })
})
