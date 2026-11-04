/** General Settings editor for the shared Session-reference pointer gesture. */
import { useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionReferenceNavigation } from '../../reference-navigation-settings.ts'
import css from './EnterBehaviorRow.module.css'
import ownCss from './ReferenceNavigationRow.module.css'

/** The configuration form owns accepted values and revisioned persistence. */
export interface ReferenceNavigationRowInjected {
  hooks: { referenceNavigation: ObservableSnapshot<Readonly<SessionReferenceNavigation>> }
  /** @param value - complete preference. @returns Host acceptance; transport failures reject. */
  setReferenceNavigation(value: Readonly<SessionReferenceNavigation>): Promise<boolean>
}

type Props = PropsRuntime<'settings.general.item'> & PropsLocale<'conversation'> & InjectFace<ReferenceNavigationRowInjected>

/**
 * Edit presets or an exact multi-modifier combination without a separate storage path.
 * @param props - the shared settings projection and locale seat.
 * @returns the settings row and any local save failure.
 */
export function ReferenceNavigationRow({ useReferenceNavigation, setReferenceNavigation, t }: Props) {
  const accepted = useReferenceNavigation(snapshot => snapshot)
  const [pending, setPending] = useState<Readonly<SessionReferenceNavigation> | null>(null)
  const value = pending ?? accepted
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = async (next: Readonly<SessionReferenceNavigation>): Promise<void> => {
    setSaving(true)
    setFailed(false)
    setPending(next)
    try { setFailed(!await setReferenceNavigation(next)) }
    catch (_error: unknown) { setFailed(true) }
    finally { setPending(null); setSaving(false) }
  }
  const gestures = ['click', 'double-click', 'modifier-click', 'custom'] as const
  return <div className={ownCss.root}>
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.reference.title')}</div>
        <div className={css.desc}>{t('settings.reference.description')}</div>
      </div>
      <Menu open={open} onClose={() => { setOpen(false) }} align="end" portal
        items={gestures.map(id => ({ id, label: t(`settings.reference.${id}`) }))}
        selectedId={value.gesture}
        onSelect={(id) => {
          setOpen(false)
          void save({ ...value, gesture: id as SessionReferenceNavigation['gesture'] })
        }}
        anchor={<button type="button" className={css.selector} aria-haspopup="menu" aria-expanded={open}
          aria-label={t('settings.reference.title')} disabled={saving} onClick={() => { setOpen(current => !current) }}>
          {t(`settings.reference.${value.gesture}`)}<IconChevronDownOutlineRegular className={css.chevron} />
        </button>}
      />
    </div>
    {value.gesture === 'custom' && <fieldset className={ownCss.custom} disabled={saving}>
      <legend>{t('settings.reference.custom')}</legend>
      <label>{t('settings.reference.clickCount')}
        <select aria-label={t('settings.reference.clickCount')} value={value.clicks} onChange={(event) => { void save({ ...value, clicks: event.currentTarget.value as SessionReferenceNavigation['clicks'] }) }}>
          <option value="single">{t('settings.reference.click')}</option>
          <option value="double">{t('settings.reference.double-click')}</option>
        </select>
      </label>
      {(['control', 'meta', 'alt', 'shift'] as const).map(modifier => <label key={modifier}>
        <input type="checkbox" checked={value[modifier]} onChange={(event) => { void save({ ...value, [modifier]: event.currentTarget.checked }) }} />
        {t(`settings.reference.${modifier}`)}
      </label>)}
    </fieldset>}
    {failed && <div className={ownCss.error} role="alert">{t('settings.reference.failed')}</div>}
  </div>
}
