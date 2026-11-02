/** Conversation-header entry using the current Host catalog and generated Remote contribution. */
import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import mailboxRemote from '@deepseek-ai/dsh-api-session-mailbox-controller/remote'
import { draftPartition, sessionDraftStore, type MailboxDraftStore } from './drafts.ts'
import { MailboxDialog } from './MailboxDialog.tsx'
import type { MailboxRemote } from './transport.ts'
import { NS, en, zh, type MailboxKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'session-mailbox': MailboxKey }
}

/** Only the authenticated current Host's generated Remote connection is used. */
export const inject = ['remote', 'sessions', 'slots', 'locale']
function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
type Panel = { readonly mailbox: MailboxRemote; readonly drafts: MailboxDraftStore }
type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & {
  openPanel: () => Promise<Panel>
  onReset: (callback: () => void) => () => void
}
function MailboxAction({ sessionId, useSessions, t, openPanel, onReset }: Props) {
  const [panel, setPanel] = useState<Panel>()
  const [failed, setFailed] = useState(false)
  const epoch = useRef(0)
  const opening = useRef(false)
  useEffect(() => {
    epoch.current++
    opening.current = false
    setPanel(undefined)
    return () => { epoch.current++ }
  }, [sessionId])
  useEffect(() => onReset(() => {
    epoch.current++
    opening.current = false
    setPanel(undefined)
  }), [onReset])
  const targets = useSessions(state => state.ids.filter(id => state.byId[id]?.origin !== 'subagent'
    && state.byId[id]?.formatStatus !== 'migration-required').map(id => ({ id, title: id })))
  return <>
    <button type="button" onClick={() => {
      if (opening.current) return
      opening.current = true
      const selectedEpoch = epoch.current
      setFailed(false)
      void openPanel().then((result) => {
        if (epoch.current === selectedEpoch) setPanel(result)
      }).catch(() => {
        if (epoch.current === selectedEpoch) setFailed(true)
      }).finally(() => {
        if (epoch.current === selectedEpoch) opening.current = false
      })
    }}>{t('title')}</button>
    {failed && <span role="status">{t('unavailable')}</span>}
    {panel && <MailboxDialog key={sessionId} sessionId={sessionId} targets={targets}
      remote={panel.mailbox} drafts={panel.drafts} t={t} close={() => { setPanel(undefined) }} />}
  </>
}

/** Mount the real generated namespace and register a visible Session-header action. */
export async function apply(ctx: Context): Promise<void> {
  const dispose = await ctx.remote.$mount(mailboxRemote)
  ctx.effect(() => dispose, 'session-mailbox: Remote contribution')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-mailbox: dictionaries')
  // Access storage lazily: a denied browser store blocks sends without breaking the application.
  const storage = {
    getItem: (key: string) => window.sessionStorage.getItem(key),
    setItem: (key: string, value: string) => { window.sessionStorage.setItem(key, value) },
  }
  const api = ctx.remote.sessionMailbox
  const openPanel = async (): Promise<Panel> => {
    // Identity is fetched anew on every explicit opening; it never grants authority.
    const identity = value(await api.identity())
    const drafts = sessionDraftStore(storage, draftPartition(window.location.href, identity))
    const mailbox: MailboxRemote = {
      grant: async route => value(await api.grant(route, identity)),
      prepare: async (grant, operation) => value(await api.prepare(grant, operation)),
      execute: async (selection, signal) => value(await api.execute(selection, signal)),
      revoke: async (grant) => { value(await api.revoke(grant)) },
    }
    return { mailbox, drafts }
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'session-mailbox', order: -10, locale: NS,
    inject: () => ({ openPanel, onReset: (callback: () => void) => ctx.on('connection/reset', callback) }),
  }, MailboxAction))
}
