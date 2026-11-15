/** Explicit queue-only send and inbox UI; session references are never interpreted as instructions. */
import { Button, IconChevronDownOutlineRegular, Menu, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useId, useRef, useState } from 'react'
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
  const [records, setRecords] = useState<readonly MailboxMessage[]>()
  const [operation, setOperation] = useState<'send' | 'read' | 'ack'>()
  const busy = operation !== undefined
  const [choosing, setChoosing] = useState(false)
  const [status, setStatus] = useState('')
  const targetLabel = useId()
  const messageId = useId()
  const availableTargets = targets.filter(item => item.id !== sessionId)
  const selectedTarget = availableTargets.find(item => item.id === target)
  const request = useRef({ id: saved?.requestId ?? randomUUID(), target, text })
  const active = useRef<AbortController>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; active.current?.abort() }
  }, [])
  const run = async (kind: 'send' | 'read' | 'ack', action: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    if (active.current) return
    const pending = new AbortController()
    active.current = pending
    setOperation(kind)
    setChoosing(false)
    setStatus('')
    try { await action(pending.signal) } catch (error) {
      if (mounted.current) setStatus(t(error instanceof MailboxDraftError ? 'draftFailed' : kind === 'send' ? 'unknown' : 'inboxFailed'))
    } finally {
      if (active.current === pending) active.current = undefined
      if (mounted.current) setOperation(undefined)
    }
  }
  const read = async (signal: AbortSignal): Promise<void> => {
    const result = await selectedOperation(remote, { action: 'inbox', target: sessionId }, { action: 'inbox' }, signal)
    if (!Array.isArray(result)) throw new Error('Expected inbox')
    if (mounted.current) setRecords(result)
  }
  const send = async (signal: AbortSignal): Promise<void> => {
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
  }
  return <Modal open className={css.dialog as string} contentClassName={css.content as string}
    title={t('title')} closeLabel={t('close')} onClose={() => { active.current?.abort(); close() }}>
    <div className={css.body}>
      <p className={css.notice}>{t('notice')}</p>
      {pendingDraft && <div className={css.pending}>
        <p>{t('pending')}</p>
        <details><summary>{t('requestId')}</summary><code>{pendingDraft.requestId}</code></details>
      </div>}
      <div className={css.field}>
        <span id={targetLabel}>{t('target')}</span>
        <Menu open={choosing && !busy && !pendingDraft} portal autoFocus minWidthFromAnchor
          className={css.targetAnchor} listClassName={css.targetMenu} selectedId={target}
          items={availableTargets.map(item => ({
            id: item.id, label: <span className={css.targetTitle} title={item.title}>{item.title}</span>,
          }))}
          onSelect={(id) => {
            const selected = availableTargets.find(item => item.id === id)
            if (selected) setTarget(selected.id)
            setChoosing(false)
          }}
          onClose={() => { setChoosing(false) }}
          anchor={<button type="button" data-modal-autofocus className={css.target}
            data-placeholder={!target || undefined}
            aria-labelledby={targetLabel} aria-haspopup="menu" aria-expanded={choosing && !busy && !pendingDraft}
            disabled={busy || !!pendingDraft || availableTargets.length === 0}
            onClick={() => { setChoosing(value => !value) }}>
            <span className={css.targetTitle}
              title={selectedTarget?.title ?? target}>{selectedTarget?.title ?? target ?? t('choose')}</span>
            <IconChevronDownOutlineRegular size={16} />
          </button>} />
        {availableTargets.length === 0 && <p className={css.hint}>{t('noTargets')}</p>}
      </div>
      <div className={css.field}>
        <label htmlFor={messageId}>{t('message')}</label>
        <textarea id={messageId} className={css.message} disabled={busy || !!pendingDraft} value={text}
          placeholder={t('messagePlaceholder')} onChange={(event) => { setText(event.target.value) }} />
      </div>
      <div className={css.sendActions}>
        <Button variant="primary" disabled={busy || !selectedTarget || (!pendingDraft && !text.trim())}
          aria-busy={operation === 'send'} onClick={() => { void run('send', send) }}>
          {operation === 'send' && <StateDot state="ongoing" />}{t(pendingDraft ? 'reconcile' : 'send')}
        </Button>
      </div>
      <p className={css.status} role="status">{status}</p>
      <section className={css.inbox} aria-label={t('inbox')}>
        <div className={css.inboxHeader}>
          <h3>{t('inbox')}</h3>
          <Button variant="outline" size="sm" disabled={busy} aria-busy={operation === 'read'}
            onClick={() => { void run('read', read) }}>
            {operation === 'read' && <StateDot state="ongoing" size={12} />}{t(records === undefined ? 'read' : 'refresh')}
          </Button>
        </div>
        {records === undefined ? <p className={css.hint}>{t('inboxHint')}</p>
          : <InboxPanel t={t} records={records} targets={targets} busy={busy} acknowledge={(record) => { void run('ack', async (signal) => {
            await selectedOperation(remote, { action: 'ack', target: sessionId }, { action: 'ack', id: record.id }, signal)
            await read(signal)
          }) }} />}
      </section>
    </div>
  </Modal>
}
