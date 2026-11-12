/** Conversation shortcuts sharing the global Session actions and native reference drag. */
import { useMemo, useRef, useState, type DragEvent } from 'react'
import clsx from 'clsx'
import { StateDot, useRowDragPreview } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import { deriveFlat, type ArchivedFilter, type SessionNode } from './tree.ts'
import { SESSION_REFERENCE_DRAG_TYPE, writeSessionReference } from './session-drag.ts'
import css from './SidebarSections.module.css'

/** Native drag metadata for moving a shortcut between sidebar sections. */
const SIDEBAR_SESSION_TYPE = 'application/x-dsh-sidebar-session'
const PREVIEW_PROPERTIES = ['--dsh-sidebar-row-padding', '--dsh-sidebar-label-gap', '--dsh-sidebar-paint-inset'] as const

/** Data and actions the same-package shortcut rows consume from the browser. */
export type SidebarSessionProps = Pick<WorkspaceBrowserProps,
  'useSessions' | 'useWorkspaces' | 'useSessionStatus' | 'usePanelInfo' | 'useContextMenu'
  | 'useContextMenuTarget' | 'renderFactorySlot' | 'renderSlot' | 'open' | 't'>

/**
 * Resolve only a current Session from a sidebar drag; external or stale payloads cannot move rows.
 * @param event - native drag currently being dropped.
 * @param list - current catalog against which the native payload is checked.
 * @returns the parsed current Session and originating section, when available.
 */
export function sidebarSessionDrop(event: DragEvent<HTMLElement>, list: SessionListState):
  { sessionId: SessionId; source: string } | undefined {
  const sidebarPayload = event.dataTransfer.getData(SIDEBAR_SESSION_TYPE)
  let value: unknown
  try { value = JSON.parse(sidebarPayload || event.dataTransfer.getData(SESSION_REFERENCE_DRAG_TYPE)) }
  catch (_invalidDragPayload) { return undefined }
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || typeof value.sessionId !== 'string') return undefined
  if (sidebarPayload !== '' && (!('source' in value) || typeof value.source !== 'string')) return undefined
  const payloadId = value.sessionId
  const sessionId = list.ids.find(id => id === payloadId)
  const session = sessionId === undefined ? undefined : list.byId[sessionId]
  if (session === undefined || session.blank || session.origin === 'subagent') return undefined
  return {
    sessionId: session.id,
    source: sidebarPayload !== '' && 'source' in value && typeof value.source === 'string' ? value.source : 'workspace',
  }
}

/** Whether a drag was issued by a sidebar shortcut rather than a file or text selection. */
export function isSidebarSessionDrag(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(SIDEBAR_SESSION_TYPE) || event.dataTransfer.types.includes(SESSION_REFERENCE_DRAG_TYPE)
}

/**
 * Render an ordered shortcut list without creating a nested scrollport.
 * @param props - browser bindings, ordered identities, source section and optional move operation.
 * @returns ordinary list rows in the owning sidebar scroller.
 */
export function SidebarSessionRows({ sessionIds, source, onMove, archivedFilter = 'default', ...props }: SidebarSessionProps & {
  sessionIds: readonly SessionId[]
  source: string
  archivedFilter?: ArchivedFilter
  onMove?: ((sessionId: SessionId, beforeId?: SessionId) => void) | undefined
}) {
  const list = props.useSessions(state => state)
  const archivedSessionIds = props.useWorkspaces(state => state.archivedSessionIds)
  const pinnedSessionIds = props.useWorkspaces(state => state.pinnedSessionIds)
  const statuses = props.useSessionStatus(state => state)
  const panelActive = props.usePanelInfo(state => state.activePanelId !== null)
  const current = panelActive ? undefined : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const rows = useMemo(() => {
    const byId = new Map(deriveFlat(list, sessionIds,
      { archivedSessionIds, pinnedSessionIds, archivedFilter }, statuses).map(row => [row.id, row]))
    return sessionIds.flatMap((id) => {
      const row = byId.get(id)
      return row === undefined ? [] : [row]
    })
  }, [list, sessionIds, archivedSessionIds, pinnedSessionIds, statuses, archivedFilter])
  return <div className={css.list} role="list">
    {rows.map((row, index) => <SidebarSessionRow key={row.id} {...props} row={row} current={current}
      source={source} onMove={onMove} afterId={rows[index + 1]?.id} />)}
  </div>
}

/** One shortcut: its activation button and action buttons are siblings. */
function SidebarSessionRow({ row, current, source, onMove, afterId, ...props }: SidebarSessionProps & {
  row: SessionNode
  current: SessionId | undefined
  source: string
  onMove: ((sessionId: SessionId, beforeId?: SessionId) => void) | undefined
  afterId: SessionId | undefined
}) {
  const list = props.useSessions(state => state)
  const { getTriggerProps } = props.useContextMenu()
  const menuOpen = props.useContextMenuTarget(target => target?.kind === 'session' && target.value.sessionId === row.id)
  const [marker, setMarker] = useState<'before' | 'after' | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const preview = useRowDragPreview(css.dragPreview ?? '', PREVIEW_PROPERTIES)
  const title = row.title || props.t('session.untitled')
  const target = { kind: 'session', value: { sessionId: row.id, displayTitle: row.title } } as const
  const pending = row.pendingInteraction !== undefined
  const running = row.running || row.runningSubagentCount > 0
  return <div ref={rowRef} role="listitem" data-row-key={`${source}-session:${row.id}`}
    className={clsx(css.sessionRow, row.id === current && css.selected, menuOpen && css.menuOpen,
      marker === 'before' && css.dropBefore, marker === 'after' && css.dropAfter)}
    {...getTriggerProps(target)} draggable={!row.archived}
    onDragStart={(event) => {
      if (row.archived) { event.preventDefault(); return }
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'copyMove'
      writeSessionReference(event.dataTransfer, row.id, title)
      event.dataTransfer.setData(SIDEBAR_SESSION_TYPE, JSON.stringify({ sessionId: row.id, source }))
      preview.start(event)
    }}
    onDragEnd={() => { preview.clear(); setMarker(null) }}
    onDragOver={onMove === undefined ? undefined : (event) => {
      if (!isSidebarSessionDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      setMarker(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
    }}
    onDragLeave={(event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      setMarker(null)
    }}
    onDrop={onMove === undefined ? undefined : (event) => {
      if (!isSidebarSessionDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      const dropped = sidebarSessionDrop(event, list)
      if (dropped !== undefined && dropped.sessionId !== row.id && (source !== 'pinned' || dropped.source === 'pinned')) {
        onMove(dropped.sessionId, marker === 'after' ? afterId : row.id)
      }
      setMarker(null)
    }}>
    <button type="button" className={css.openSession} aria-current={row.id === current ? 'page' : undefined}
      onClick={() => { props.open(row.id) }}>
      <span className={css.sessionTitle}>{title}</span>
      {(pending || running || row.completed) && <span aria-label={props.t(
        pending ? 'status.waitingAnswer' : running ? 'status.running' : 'status.completed',
      )}><StateDot state={pending ? 'warning' : running ? 'ongoing' : 'done'} /></span>}
    </button>
    <span className={css.sessionActions}>
      {props.renderFactorySlot('contextMenu.button', {
        target, label: props.t('actions.session.aria', { name: title }), className: css.iconButton,
      })}
      {props.renderSlot('sidebar.workspaces.session.row.action', { sessionId: row.id, displayTitle: row.title })}
    </span>
  </div>
}
