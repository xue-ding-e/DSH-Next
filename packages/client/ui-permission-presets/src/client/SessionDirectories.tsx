/** Directory selection and explicit owner confirmation; all behavior is injected. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconFolderCloseRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RootApprovalPreview, SessionRootRequest } from '@deepseek-ai/dsh-sandbox-policy/types'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from './directories.ts'
import type { DirectoryKey } from './directories-locales.ts'
import css from './SessionDirectories.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'session.directories.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
  }
  interface LocaleNamespaceMap { 'permission.directories': DirectoryKey }
}

/** Interaction callbacks plus framework-bound sources; no Context crosses into React. */
export interface SessionDirectoriesInjected {
  sessionId: SessionId
  address: string
  hooks: {
    workspaceList: HostObservable<WorkspaceSnapshot>
    directoryConnection: HostObservable<number>
    directoryLifetime: HostObservable<number>
    directoryChange: HostObservable<number>
    directoryFlow: HostObservable<boolean>
  }
  replace: (roots: readonly SessionRootRequest[], revision: number | null) => Promise<void>
  saveDefaults: (workspaceId: WorkspaceId, roots: readonly SessionRootRequest[]) => Promise<void>
  prepare: () => Promise<RootApprovalPreview>
  confirm: (nonce: string) => Promise<void>
  cancel: (nonce: string) => Promise<void>
  abort: () => void
  refresh: () => void
}

export type SessionDirectoriesProps = PropsRuntime<'conversation.session.header.utilities'>
  & PropsRenderSlots<'session.directories.directoryFlow'>
  & Omit<SessionDirectoriesInjected, 'hooks'> & PropsHooks<SessionDirectoriesInjected['hooks']>
  & PropsLocale<'permission.directories'>

/** One reachable Session utility; saved defaults and current authority stay separate. */
export function SessionDirectories({
  sessionId, address, useResource, useSession, useWorkspaceList,
  useDirectoryConnection, useDirectoryLifetime, useDirectoryChange, useDirectoryFlow,
  replace, saveDefaults, prepare, confirm, cancel, abort, refresh, renderSlot, t,
}: SessionDirectoriesProps) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'current' | 'defaults'>('current')
  const [draft, setDraft] = useState<{ roots: readonly SessionRootRequest[]; revision: number | null } | null>(null)
  const [preview, setPreview] = useState<RootApprovalPreview | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const previewRef = useRef(preview)
  previewRef.current = preview
  const resource = useResource<'session-directories'>(open ? address : '')
  const state = resource.status === 'live' ? resource.value : undefined
  const running = useSession(snapshot => snapshot.running)
  const workspace = useWorkspaceList(snapshot => snapshot.items.find(item => item.sessionIds.includes(sessionId)))
  const connection = useDirectoryConnection(value => value)
  const lifetime = useDirectoryLifetime(value => value)
  const change = useDirectoryChange(value => value)
  const hasPicker = useDirectoryFlow(value => value)
  const selected = draft?.roots ?? (tab === 'defaults' ? workspace?.additionalRoots : state?.roots) ?? []
  const disabled = busy || running || state === undefined

  useEffect(() => {
    const old = previewRef.current
    setPreview(null)
    setAcknowledged(false)
    if (old !== null) void cancel(old.nonce).catch(() => undefined)
  }, [change, cancel])
  useEffect(() => {
    ++epoch.current
    abort()
    setOpen(false)
    setDraft(null)
    setPreview(null)
    setPicking(false)
    setBusy(false)
    setError(null)
  }, [connection, lifetime, abort])
  useEffect(() => () => { ++epoch.current; abort() }, [abort])

  const close = (): void => {
    ++epoch.current
    abort()
    if (preview !== null) void cancel(preview.nonce).catch(() => undefined)
    setOpen(false); setDraft(null); setPreview(null); setPicking(false); setBusy(false); setError(null)
  }
  const run = <T,>(action: () => Promise<T>, done?: (value: T) => void): void => {
    const ticket = ++epoch.current
    setBusy(true); setError(null)
    void action().then((value) => { if (ticket === epoch.current) done?.(value) })
      .catch((reason: unknown) => { if (ticket === epoch.current) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (ticket === epoch.current) setBusy(false) })
  }
  const edit = (roots: readonly SessionRootRequest[]): void => {
    if (preview !== null) void cancel(preview.nonce).catch(() => undefined)
    setPreview(null); setAcknowledged(false)
    setDraft(current => ({ roots, revision: current === null ? state?.rootsRevision ?? null : current.revision }))
  }
  const save = (): void => {
    if (state === undefined) return
    if (tab === 'defaults') {
      if (workspace !== undefined) run(() => saveDefaults(workspace.workspaceId, selected), () => { setDraft(null) })
    } else run(() => replace(selected, draft === null ? state.rootsRevision : draft.revision), () => { setDraft(null) })
  }
  const pickerEpoch = epoch.current
  return <>
    <button type="button" title={t('open')} aria-label={t('open')} onClick={() => { setOpen(true); refresh() }}>
      <IconFolderCloseRegular />
    </button>
    <Modal open={open} onClose={close} title={t('title')} closeLabel={t('close')}>
      <div className={css.panel}>
        <div className={css.actions}>
          {(['current', 'defaults'] as const).map(value => <button key={value} type="button" aria-pressed={tab === value}
            disabled={busy} onClick={() => {
              ++epoch.current
              setPicking(false)
              if (preview !== null) void cancel(preview.nonce).catch(() => undefined)
              setTab(value); setDraft(null); setPreview(null); setAcknowledged(false); setError(null)
            }}>{t(value)}</button>)}
          <button type="button" onClick={refresh} disabled={busy}>{t('refresh')}</button>
        </div>
        {state === undefined ? <p role="status">{resource.status === 'failed' && resource.failure?.code !== 'directories/refreshing'
          ? resource.failure?.message ?? t('unavailable') : t('loading')}</p> : <>
          <p>{t('primary')}: <span className={css.path}>{state.primaryPath}</span></p>
          <p>{t('mode')}: {state.mode}</p>
          <p className={css.notice}>{tab === 'defaults' ? t('defaultsNotice') : t('referenceNotice')}</p>
          {tab === 'defaults' && workspace === undefined ? <p>{t('noWorkspace')}</p> : <>
            {selected.length === 0 && <p>{t('empty')}</p>}
            {selected.map((root, index) => <div className={css.row} key={`${index}:${root.path}`}>
              <span className={css.path}>{root.path}</span>
              <select aria-label={root.path} value={root.access} disabled={disabled} onChange={(event) => {
                const access = event.target.value === 'write' ? 'write' : 'reference'
                edit(selected.map((entry, at) => at === index ? { ...entry, access } : entry))
              }}><option value="reference">{t('reference')}</option><option value="write">{t('write')}</option></select>
              <button type="button" disabled={disabled} onClick={() => { edit(selected.filter((_, at) => at !== index)) }}>{t('remove')}</button>
            </div>)}
            <div className={css.actions}>
              <Button disabled={disabled || !hasPicker} onClick={() => { setPicking(true) }}>{t('add')}</Button>
              <Button disabled={disabled || draft === null} onClick={save}>{t('save')}</Button>
            </div>
            {!hasPicker && <p className={css.notice}>{t('pickingUnavailable')}</p>}
          </>}
          {tab === 'current' && <>
            <p className={css.notice}>{t('lifetime')}</p>
            <p>{t('active')}: {state.activeWritableRoots.length === 0 ? t('empty') : state.activeWritableRoots.join(', ')}</p>
            <p>{t('confirmedReference')}: {state.confirmedRoots.filter(root => root.access === 'reference').map(root => root.path).join(', ') || t('empty')}</p>
            <p>{t('effective')}: {state.deploymentWritableRoots.join(', ') || t('empty')}</p>
            {!state.writeSupported && <p role="status">{t('unsupported')}</p>}
            <Button disabled={disabled || draft !== null || state.roots === null
              || (!state.writeSupported && selected.some(root => root.access === 'write'))}
            onClick={() => { run(prepare, (value) => { setPreview(value); setAcknowledged(false) }) }}>{t('preview')}</Button>
          </>}
        </>}
        {preview !== null && <section aria-label={t('preview')}>
          <p>{t('primary')}: {preview.workspaceRoot}</p><p>{t('mode')}: {preview.mode}</p>
          <ul>{preview.roots.map(root => <li key={root.path}>{root.path} — {t(root.access === 'write' ? 'write' : 'reference')}</li>)}</ul>
          <p>{t('effective')}: {preview.deploymentWritableRoots.join(', ') || t('empty')}</p>
          <p className={css.notice}>{t('lifetime')}</p>
          <label><input type="checkbox" checked={acknowledged} disabled={disabled}
            onChange={(event) => { setAcknowledged(event.target.checked) }} />{t('acknowledge')}</label>
          <div className={css.actions}>
            <Button disabled={disabled || !acknowledged || Date.now() >= preview.expiresAt}
              onClick={() => { run(() => confirm(preview.nonce), () => { setPreview(null) }) }}>{t('confirm')}</Button>
            <Button disabled={busy} onClick={() => {
              const nonce = preview.nonce; setPreview(null); setAcknowledged(false); run(() => cancel(nonce))
            }}>{t('cancel')}</Button>
          </div>
        </section>}
        {error !== null && <p role="alert" className={css.error}>{error}</p>}
      </div>
    </Modal>
    {renderSlot('session.directories.directoryFlow', { open: picking, busy,
      onPicked: (path) => { if (pickerEpoch !== epoch.current || !open || !picking) return; setPicking(false); edit([...selected, { path, access: 'reference' }]) },
      onCancel: () => { if (pickerEpoch === epoch.current) setPicking(false) },
      onError: (message) => { if (pickerEpoch !== epoch.current) return; setPicking(false); setError(message) } })}
  </>
}
