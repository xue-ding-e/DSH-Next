/** Native reminder ownership follows answerable questions, independently of their composer seats. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { DesktopQuestionNotifications, QuestionNotificationId } from '../desktop-notifications.ts'

interface Reminder {
  readonly id: QuestionNotificationId
  readonly ready: Promise<void>
}

/** Owns IPC operations until all reminders are withdrawn, including submissions racing disposal. */
export class NativeQuestionNotifications {
  private readonly reminders = new Map<string, Reminder>()
  private readonly operations = new Set<Promise<void>>()
  private readonly unsubscribe: () => void
  private active = true

  /**
   * @param api - Required desktop preload capability.
   * @param open - Opens the Session and its still-answerable question.
   * @param report - Reports native submission or withdrawal failure in the app-wide overlay.
   */
  constructor(private readonly api: DesktopQuestionNotifications, private readonly open: (key: string) => void,
    private readonly report: (failure: 'native' | 'close') => void) {
    this.unsubscribe = api.subscribe((event) => {
      if (!this.active) return
      const entry = [...this.reminders].find(([, reminder]) => reminder.id === event.id)
      if (entry === undefined) return
      const [key] = entry
      this.close(key)
      if (event.type === 'failed') this.report('native')
      else this.open(key)
    })
  }

  /**
   * Submit once for one answerable question; duplicate delivery keeps its original reminder.
   * @param key - Renderer-owned question key.
   * @param title - Localized notification title.
   * @param body - Plain question text.
   */
  show(key: string, title: string, body: string): void {
    if (!this.active || this.reminders.has(key)) return
    const id = brandString<QuestionNotificationId>(randomUUID())
    const ready = Promise.withResolvers<void>()
    this.reminders.set(key, { id, ready: ready.promise })
    const submit = async (): Promise<void> => {
      try {
        const result = await this.api.show({ id, title, body })
        if (result !== 'submitted' && this.active && this.reminders.get(key)?.id === id) {
          this.reminders.delete(key)
          this.report('native')
        }
      } catch (error) {
        console.error('Question notification submission failed', error)
        if (this.active && this.reminders.get(key)?.id === id) {
          this.close(key)
          this.report('native')
        }
      } finally { ready.resolve() }
    }
    this.track(submit())
  }

  /**
   * Invalidate a reminder immediately, then withdraw it after any pending submission.
   * @param key - Resolved, opened, or disabled question whose reminder must stop accepting clicks.
   */
  close(key: string): void {
    const reminder = this.reminders.get(key)
    if (reminder === undefined) return
    this.reminders.delete(key)
    const closing = reminder.ready.then(async () => { await this.api.close(reminder.id) }).catch((error: unknown) => {
      console.error('Question notification withdrawal failed', error)
      if (this.active) this.report('close')
    })
    this.track(closing)
  }

  /** Withdraw every reminder without changing the local notification preference. */
  clear(): void { for (const key of this.reminders.keys()) this.close(key) }

  /**
   * Stop callbacks and withdraw all reminders before releasing the owner.
   * @returns After pending submissions and native withdrawals settle; no callback can navigate afterward.
   */
  async dispose(): Promise<void> {
    this.active = false
    this.unsubscribe()
    this.clear()
    await Promise.all(this.operations)
  }

  private track(operation: Promise<void>): void {
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) })
  }
}
