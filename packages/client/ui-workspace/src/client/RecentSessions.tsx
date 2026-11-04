/** Recent conversation shortcuts ordered by this device's navigation and Host updates. */
import { useId, useMemo } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceBrowserInjected, WorkspaceViewStoreHandle } from './contract/slots.ts'
import { deriveFlat, recentSessionIds } from './tree.ts'
import { writeSessionReference } from './session-drag.ts'
import css from './rows/WorkspaceBrowser.module.css'
import rowsCss from './rows/Rows.module.css'

/** Props for the sidebar's independent recent-conversation seat. */
export type RecentSessionsProps = PropsRuntime<'sidebar.recent'>
  & PropsStore<WorkspaceViewStoreHandle>
  & Pick<WorkspaceBrowserInjected, 'open'> & PropsLocale<'workspace'>

/**
 * Render recent conversations without changing the Workspace tree's order or filters.
 * @param props - sidebar geometry, current catalogs, viewing store and navigation.
 * @returns recent shortcuts, or nothing in the collapsed rail and empty catalogs.
 */
export function RecentSessions({
  wide, useSessions, useWorkspaces, useSessionStatus, usePanelInfo, useStore, open, t,
}: RecentSessionsProps) {
  const labelId = useId()
  const list = useSessions(state => state)
  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const pinnedSessionIds = useWorkspaces(state => state.pinnedSessionIds)
  const statuses = useSessionStatus(state => state)
  const openedAt = useStore(state => state.openedAt)
  const panelActive = usePanelInfo(state => state.activePanelId !== null)
  const current = panelActive ? undefined : Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const rows = useMemo(() => {
    const ids = recentSessionIds(list, archivedSessionIds, 5, openedAt)
    const byId = new Map(deriveFlat(list, ids, { archivedSessionIds, pinnedSessionIds, archivedFilter: 'default' }, statuses).map(row => [row.id, row]))
    return ids.flatMap((id) => {
      const row = byId.get(id)
      return row === undefined ? [] : [row]
    })
  }, [list, archivedSessionIds, pinnedSessionIds, statuses, openedAt])
  if (!wide || rows.length === 0) return null
  return (
    <section className={css.recentSection} aria-labelledby={labelId}>
      <div id={labelId} className={css.recentLabel}>{t('section.recent')}</div>
      <div className={css.recentList}>
        {rows.map((row) => {
          const title = row.title || t('session.untitled')
          const pending = row.pendingInteraction !== undefined
          const running = row.running || row.runningSubagentCount > 0
          return (
            <button key={row.id} type="button"
              data-row-key={`recent-session:${row.id}`}
              className={`${rowsCss.sessionRow} ${row.id === current ? rowsCss.selected : ''}`}
              aria-current={row.id === current ? 'page' : undefined}
              onClick={() => { open(row.id) }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy'
                writeSessionReference(event.dataTransfer, row.id, title)
              }}>
              <span className={rowsCss.slot} aria-label={pending || running || row.completed
                ? t(pending ? 'status.waitingAnswer' : running ? 'status.running' : 'status.completed') : undefined}>
                {(pending || running || row.completed) && <StateDot
                  state={pending ? 'warning' : running ? 'ongoing' : 'done'} />}
              </span>
              <span className={rowsCss.title}>{title}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
