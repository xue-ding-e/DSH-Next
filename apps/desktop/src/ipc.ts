/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopFileDrag } from '@deepseek-ai/dsh-util-file-drag'
import type { DesktopQuestionNotifications } from '@deepseek-ai/dsh-client-ui-user-questions'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  boot: 'dsh-desktop:boot',
  enterWorkspace: 'dsh-desktop:enter-workspace',
  onboardingActive: 'dsh-desktop:onboarding-active',
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  bootFailed: 'dsh-desktop:boot-failed',
  browserAcquire: 'dsh-desktop:browser-acquire',
  browserRelease: 'dsh-desktop:browser-release',
  browserOpenRequested: 'dsh-desktop:browser-open-requested',
  // Side mouse buttons arrive as App Commands in the main process, never as DOM
  // events in the page. See the note on DesktopNavigationCommand.
  navigationCommand: 'dsh-desktop:navigation-command',
  questionNotificationShow: 'dsh-desktop:question-notification-show',
  questionNotificationClose: 'dsh-desktop:question-notification-close',
  questionNotificationEvent: 'dsh-desktop:question-notification-event',
  directoryPick: 'dsh-desktop:directory-pick',
  fileDragPrepare: 'dsh-desktop:file-drag-prepare',
  fileDragCancel: 'dsh-desktop:file-drag-cancel',
  fileDragStart: 'dsh-desktop:file-drag-start',
  fileDragRelease: 'dsh-desktop:file-drag-release',
  deviceInfo: 'dsh-desktop:device-info',
  localeBootstrap: 'dsh-desktop:locale-bootstrap',
  localeChanged: 'dsh-desktop:locale-changed',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/**
 * A history step requested by a side mouse button or a media/browser key.
 *
 * On Windows and Linux these never reach the page as DOM events: the OS turns
 * `APPCOMMAND_BROWSER_BACKWARD` / `..._FORWARD` into the window's `app-command`
 * event, which only the main process can observe. Listening for `auxclick` in the
 * renderer therefore works only for the subset Chromium happens to translate,
 * which is why one button can appear to work while the other does nothing.
 */
export type DesktopNavigationCommand = 'back' | 'forward'

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly fileDrag: DesktopFileDrag
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  readonly questionNotifications: DesktopQuestionNotifications
  readonly navigation: {
    /**
     * Subscribe to side-button navigation from the main process.
     * @param listener - receives each requested direction.
     * @returns the unsubscribe function.
     */
    subscribe(listener: (command: DesktopNavigationCommand) => void): () => void
  }
  /**
   * Local machine description for the feedback questionnaire.
   * @returns `name=value` fields separated by `; `, with no hostname, user name, or serial number.
   */
  deviceInfo(): Promise<string>
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'dsh-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
