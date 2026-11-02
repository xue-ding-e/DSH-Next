/** Explicit queue-only send and inbox UI; session references are never interpreted as instructions. */
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MailboxMessage } from '@deepseek-ai/dsh-api-session-mailbox-controller/types'
import type { MailboxRemote } from './transport.ts'
import { selectedOperation } from './transport.ts'
import { english, type MailboxTranslate } from './locales.ts'
import { MailboxDraftError, type MailboxDraftStore } from './drafts.ts'
import css from './MailboxDialog.module.css'
import { InboxPanel } from './InboxPanel.tsx'

/** Each mount is bound to one selected Session; its caller keys by Session identity. */
export function MailboxDialog({ sessionId, targets, remote, close, drafts, t = english }: {
  sessionId: SessionId
  targets: readonly { id: SessionId; title: string }[]
  remote: MailboxRemote
  close: () => void
  t?: MailboxTranslate
  drafts?: MailboxDraftStore
}) {
  const [saved] = useState(() => {
    try { return drafts?.read(sessionId) } catch { return undefined }
  })
  const [pendingDraft, setPendingDraft] = useState(saved)
  const [target, setTarget] = useState<SessionId | undefined>(saved?.target)
  const [text, setText] = useState(saved?.text ?? '')
  const [records, setRecords] = useState<readonly MailboxMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const request = useRef({ id: saved?.requestId ?? randomUUID(), target, text })
  const active = useRef<AbortController>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.abort() }
  }, [])
  const run = async (operation: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    if (active.current) return
    const pending = new AbortController()
    active.current = pending
    setBusy(true)
    setStatus('')
    try { await operation(pending.signal) } catch (error) {
      if (mounted.current) setStatus(t(error instanceof MailboxDraftError ? 'draftFailed' : 'unknown'))
    } finally {
      if (active.current === pending) active.current = undefined
      if (mounted.current) setBusy(false)
    }
  }
  const read = async (signal: AbortSignal): Promise<void> => {
    const result = await selectedOperation(remote, { action: 'inbox', target: sessionId }, { action: 'inbox' }, signal)
    if (!Array.isArray(result)) throw new Error('Expected inbox')
    if (mounted.current) setRecords(result)
  }
  return <Modal open title={t('title')} closeLabel={t('close')} onClose={() => { active.current?.abort(); close() }}>
    <div className={css.body}>
      <p>{t('notice')}</p>
      {pendingDraft && <p>{t('pending')} <code>{pendingDraft.requestId}</code></p>}
      <label>{t('target')}<select data-modal-autofocus disabled={busy || !!pendingDraft} value={target ?? ''} onChange={(event) => { setTarget(event.target.value as SessionId) }}>
        <option value="">{t('choose')}</option>
        {targets.filter(item => item.id !== sessionId).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label>{t('message')}<textarea disabled={busy || !!pendingDraft} value={text} onChange={(event) => { setText(event.target.value) }} /></label>
      <button type="button" disabled={busy || !target || (!pendingDraft && !text.trim()) || !targets.some(item => item.id === target)} onClick={() => { void run(async (signal) => {
        if (!target) return
        if (request.current.target !== target || request.current.text !== text) request.current = { id: randomUUID(), target, text }
        // Persist the retry identity before granting any route or sending the body.
        const durableDraft = drafts?.save(sessionId, target, text)
        if (durableDraft) { request.current.id = durableDraft.requestId; setPendingDraft(durableDraft) }
        const result = await selectedOperation(remote, { action: 'send', source: sessionId, target }, { action: 'send', requestId: request.current.id, text }, signal)
        if ('outcome' in result) {
          drafts?.complete(sessionId, request.current.id)
          if (mounted.current) { setPendingDraft(undefined); setStatus(t('notAccepted')) }
          request.current.id = randomUUID()
          return
        }
        try { drafts?.complete(sessionId, request.current.id) } catch {
          if (mounted.current) setStatus(t('queuedRetryRetained'))
          return
        }
        if (mounted.current) setPendingDraft(undefined)
        request.current.id = randomUUID()
        if (mounted.current) setStatus(t('queued'))
      }) }}>{t('send')}</button>
      <button type="button" disabled={busy} onClick={() => { void run(read) }}>{t('read')}</button>
      <InboxPanel t={t} records={records} busy={busy} acknowledge={(record) => { void run(async (signal) => {
        await selectedOperation(remote, { action: 'ack', target: sessionId }, { action: 'ack', id: record.id }, signal)
        await read(signal)
      }) }} />
      <p role="status">{status}</p>
    </div>
  </Modal>
}
