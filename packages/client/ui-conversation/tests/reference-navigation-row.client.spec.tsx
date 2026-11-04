// @vitest-environment jsdom
/** Settings saves give immediate field feedback while accepted gestures remain owned by configForms. */
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import { ReferenceNavigationRow } from '../src/client/settings/ReferenceNavigationRow.tsx'
import { ReferenceNavigationPreference } from '../src/client/reference-navigation-preference.ts'
import { DEFAULT_SESSION_REFERENCE_NAVIGATION as DEFAULT } from '../src/reference-navigation-settings.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'

afterEach(cleanup)

function bench(custom = false) {
  const host = stubConfigForm<ConversationSettings>()
  host.publish({ status: 'ready', value: { busyEnter: 'queue', sessionReferenceNavigation: { ...DEFAULT, gesture: custom ? 'custom' : 'click' } },
    revision: 1, writable: true })
  const preference = new ReferenceNavigationPreference(host.scope)
  onTestFinished(() => { preference.dispose() })
  const props = {
    useReferenceNavigation: bindSnapshotSelector(preference.state),
    setReferenceNavigation: value => preference.set(value),
    t: makeTranslate(zh, commonZh),
  } satisfies Pick<ComponentProps<typeof ReferenceNavigationRow>, 'useReferenceNavigation' | 'setReferenceNavigation' | 't'>
  return { host, preference, ...render(<ReferenceNavigationRow {...props as ComponentProps<typeof ReferenceNavigationRow>} />) }
}

describe('Session reference navigation row', () => {
  it('keeps a clicked modifier visibly checked while the Host write is pending', async () => {
    const b = bench(true)
    let accept!: (value: boolean) => void
    const pending = new Promise<boolean>((resolve) => { accept = resolve })
    b.host.set.mockReturnValueOnce(pending)
    const control = b.getByRole('checkbox', { name: 'Ctrl' }) as HTMLInputElement
    fireEvent.click(control)
    expect(control.checked).toBe(true)
    expect(control.matches(':disabled')).toBe(true)
    expect(b.preference.state.getSnapshot().control).toBe(false)
    await act(async () => {
      b.host.publish({ value: { busyEnter: 'queue', sessionReferenceNavigation: { ...DEFAULT, gesture: 'custom', control: true } }, revision: 2 })
      accept(true)
    })
    expect(control.checked).toBe(true)
    expect(control.matches(':disabled')).toBe(false)
    expect(b.preference.state.getSnapshot().control).toBe(true)
  })

  it('restores the accepted field and reports a refusal or transport failure beside the setting', async () => {
    const b = bench(true)
    const control = b.getByRole('checkbox', { name: 'Ctrl' }) as HTMLInputElement
    b.host.set.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(control) })
    expect(control.checked).toBe(false)
    expect(b.getByRole('alert').textContent).toBe(zh['settings.reference.failed'])
    b.host.set.mockRejectedValueOnce(new Error('transport'))
    await act(async () => { fireEvent.click(control) })
    expect(control.checked).toBe(false)
    expect(b.getByRole('alert').textContent).toBe(zh['settings.reference.failed'])
  })
})
