import { english, type MailboxTranslate } from './locales.ts'
/** Untrusted messages remain text nodes; read acknowledgement does not execute them. */
import type { MailboxMessage } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'

/** Target-session inbox rendering independent of transport and Agent state. */
export function InboxPanel({ records, busy, acknowledge, t = english }: {
  records: readonly MailboxMessage[]
  busy: boolean
  t?: MailboxTranslate
  acknowledge: (record: MailboxMessage) => void
}) {
  return <ul aria-label={t('inbox')}>
    {records.map(record => <li key={record.id}>
      <span>{record.source} → {record.target} · {record.status}</span>
      <pre>{record.text}</pre>
      <button type="button" disabled={busy || record.status !== 'queued'} onClick={() => { acknowledge(record) }}>{t('ack')}</button>
    </li>)}
  </ul>
}
