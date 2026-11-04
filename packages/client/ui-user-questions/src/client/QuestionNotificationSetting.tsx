/** Desktop setting for system notifications about answerable questions. */
import type {
  HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './QuestionNotificationSetting.module.css'

/** Preference state and mutation supplied by the question plugin. */
export interface QuestionNotificationSettingInjected {
  hooks: { enabled: HostObservable<boolean>; preferenceError: HostObservable<boolean> }
  setEnabled: (enabled: boolean) => void
}

/** Full props of the General Settings row. */
export type QuestionNotificationSettingProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'question'>
  & PropsHooks<QuestionNotificationSettingInjected['hooks']>
  & InjectFace<Omit<QuestionNotificationSettingInjected, 'hooks'>>

/**
 * Render the device preference and any persistence failure beside its control.
 * @param props - Observable preference, write status, localized copy, and setting action.
 * @returns The notification preference row.
 */
export function QuestionNotificationSetting({ useEnabled, usePreferenceError, setEnabled, t }: QuestionNotificationSettingProps) {
  const enabled = useEnabled(value => value)
  const error = usePreferenceError(value => value)
  return (
    <div className={css.row}>
      <div className={css.copy}>
        <div className={css.title}>{t('settings.notifications.title')}</div>
        <div className={css.description} role={error ? 'alert' : undefined}>
          {t(error ? 'settings.notifications.unsaved' : 'settings.notifications.description')}
        </div>
      </div>
      <Switch checked={enabled} onChange={setEnabled} label={t('settings.notifications.title')} />
    </div>
  )
}
