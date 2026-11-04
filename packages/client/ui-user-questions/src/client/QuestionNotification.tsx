/** App-wide error reports for desktop question notifications. */
import type {
  HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

/** One localized failure shown by the overlay that outlives the composer and Settings. */
export interface QuestionNotificationErrorState {
  readonly kind: 'native' | 'close' | 'open'
  readonly seq: number
}

/** Notification failure state and dismissal supplied by the desktop owner. */
export interface QuestionNotificationInjected {
  hooks: {
    notificationError: HostObservable<QuestionNotificationErrorState | null>
  }
  dismissError: () => void
}

/** Full props of the frame-wide question notification. */
export type QuestionNotificationProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'question'>
  & PropsHooks<QuestionNotificationInjected['hooks']>
  & InjectFace<Omit<QuestionNotificationInjected, 'hooks'>>

/**
 * Render desktop notification failures outside the conversation panel.
 * @param props - Observable failure, localized copy, and dismissal action.
 * @returns A transient failure report, or nothing when delivery has not failed.
 */
export function QuestionNotification({
  useNotificationError, dismissError, t,
}: QuestionNotificationProps) {
  const error = useNotificationError(value => value)
  if (error === null) return null
  return <Toast key={error.seq} text={t(error.kind === 'native' ? 'notification.failed'
    : error.kind === 'close' ? 'notification.closeFailed' : 'notification.openFailed')} holdMs={8000} onDone={dismissError} />
}
