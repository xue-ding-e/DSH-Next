/** Electron notification messages shared by the question UI and isolated preload. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One native reminder owned by a single question-plugin lifetime. */
export type QuestionNotificationId = Branded<'QuestionNotificationId'>

/** Localized plain text; routing stays in the renderer that owns the question. */
export interface DesktopQuestionNotification {
  readonly id: QuestionNotificationId
  readonly title: string
  readonly body: string
}

/** Submission does not establish that the OS displayed a banner or that the user saw it. */
export type DesktopQuestionNotificationResult = 'submitted' | 'unsupported' | 'failed'

/** Native callbacks refer only to a reminder that the requesting document still owns. */
export type DesktopQuestionNotificationEvent = {
  readonly type: 'activated' | 'failed'
  readonly id: QuestionNotificationId
}

/** Desktop-only operations; Web uses its in-application question notice. */
export interface DesktopQuestionNotifications {
  /**
   * Submit one reminder to the OS. Native failures also arrive through subscribe.
   * @param notice - Unique reminder identity and localized text.
   * @returns Submission outcome; rejects on IPC or caller-validation failure.
   */
  show(notice: DesktopQuestionNotification): Promise<DesktopQuestionNotificationResult>
  /**
   * Withdraw an owned reminder; a reminder already withdrawn is harmless.
   * @param id - Identity supplied to show.
   * @returns After native close is requested; rejects if that request fails.
   */
  close(id: QuestionNotificationId): Promise<void>
  /**
   * Observe native failures and clicks after the main process restores and focuses the app.
   * @param listener - Receives owned reminder callbacks without Electron event objects.
   * @returns Listener removal; the caller also closes its outstanding reminders.
   */
  subscribe(listener: (event: DesktopQuestionNotificationEvent) => void): () => void
}
