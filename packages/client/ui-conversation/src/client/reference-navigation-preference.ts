/** One settings projection for every Session reference in the current Client. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConversationSettings } from '../submission-settings.ts'
import { DEFAULT_SESSION_REFERENCE_NAVIGATION, type SessionReferenceNavigation } from '../reference-navigation-settings.ts'

/** Shared live preference; writes and recovery remain owned by configForms. */
export class ReferenceNavigationPreference {
  /** Source bound to the General Settings row and sent-reference renderer. */
  readonly state = createSnapshotStore<Readonly<SessionReferenceNavigation>>(DEFAULT_SESSION_REFERENCE_NAVIGATION)
  private readonly off: () => void

  /** @param form - the conversation plugin's shared Host configuration form. */
  constructor(private readonly form: ConfigForm<ConversationSettings>) {
    const adopt = (): void => {
      const value = form.getSnapshot().value?.sessionReferenceNavigation ?? DEFAULT_SESSION_REFERENCE_NAVIGATION
      this.state.set(value)
    }
    this.off = form.subscribe(adopt)
    adopt()
  }

  /**
   * Persist a gesture through the form's revisioned write queue.
   * @param value - the complete next preference.
   * @returns whether the Host accepted the write; transport failures reject.
   */
  set(value: Readonly<SessionReferenceNavigation>): Promise<boolean> {
    return this.form.set('sessionReferenceNavigation', value)
  }

  /** Release the settings subscription when the plugin unloads. */
  dispose(): void { this.off() }
}
