import { english, type MailboxTranslate } from './locales.ts'
/** Untrusted messages remain text nodes; read acknowledgement does not execute them. */
import type { MailboxMessage } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MailboxDialog.module.css'

const receiptKeys = { queued: 'receiptQueued', acknowledged: 'receiptAcknowledged', cancelled: 'receiptCancelled' } as const

/** Target-session inbox rendering independent of transport and Agent state. */
export function InboxPanel({ records, targets, busy, acknowledge, t = english }: {
  records: readonly MailboxMessage[]
  targets: readonly { id: SessionId; title: string }[]
  busy: boolean
  t?: MailboxTranslate
  acknowledge: (record: MailboxMessage) => void
}) {
  if (records.length === 0) return <p className={css.empty}>{t('emptyInbox')}</p>
  return <ul className={css.records} aria-label={t('inbox')}>
    {records.map(record => <li className={css.record} key={record.id}>
      <div className={css.recordHeader}>
        <span className={css.sender} title={record.source}>{targets.find(item => item.id === record.source)?.title ?? record.source}</span>
        <span className={css.receiptState}>{t(receiptKeys[record.status])}</span>
      </div>
      <pre className={css.recordText}>{record.text}</pre>
      {record.status === 'queued' && <div className={css.receiptActions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { acknowledge(record) }}>{t('ack')}</Button>
      </div>}
    </li>)}
  </ul>
}
