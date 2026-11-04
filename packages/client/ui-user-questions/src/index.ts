/**
 * Web question plugin, node half.
 *
 * Mounting `ask_user_question` in the tools registry's global layer expands
 * every agent's tool list regardless of its preset. Rendering a question is
 * a host UI capability; the model-facing tool belongs to the presets that
 * include it and to the TUI composition, which has no presets.
 */

export type {
  DesktopQuestionNotification, DesktopQuestionNotificationEvent, DesktopQuestionNotificationResult,
  DesktopQuestionNotifications, QuestionNotificationId,
} from './desktop-notifications.ts'

/** Host plugin body — the model-facing tool is composed per preset, not here. */
export function apply(): void {}
