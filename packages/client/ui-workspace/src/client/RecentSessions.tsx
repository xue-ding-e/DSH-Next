/** Recent conversation section with the sidebar's organization controls. */
import { useMemo, useState } from 'react'
import {
  IconArchiveOffOutlineRegular, IconArchiveCheckOutlineRegular, IconQueueOutlineRegular,
  IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { deriveSidebarGroups, sidebarOrganizationOf } from './sidebar-organization.ts'
import { SidebarSectionFrame, SidebarSectionNameDialog, type SidebarSectionsProps } from './SidebarSections.tsx'
import { SidebarSessionRows } from './SidebarSessionRows.tsx'
import css from './SidebarSections.module.css'

const PAGE_SIZE = 20

/**
 * Render the remaining catalog after pins and named sections, with incremental disclosure.
 * @param props - browser data, viewing actions, Session menus and section-name request.
 * @returns the Recent section, including its empty heading.
 */
export function RecentSessions(props: SidebarSectionsProps) {
  const list = props.useSessions(state => state)
  const archived = props.useWorkspaces(state => state.archivedSessionIds)
  const pinned = props.useWorkspaces(state => state.pinnedSessionIds)
  const organization = props.useStore(sidebarOrganizationOf)
  const groupBy = props.useStore(state => state.groupBy)
  const archivedFilter = props.useStore(state => state.archivedFilter ?? 'default')
  const groups = useMemo(() => {
    const groups = deriveSidebarGroups(list, archivedFilter === 'default' ? archived : [], pinned, organization)
    return archivedFilter === 'only' ? { ...groups, recent: groups.recent.filter(id => archived.includes(id)) } : groups
  }, [list, archived, pinned, organization, archivedFilter])
  const [quota, setQuota] = useState(PAGE_SIZE)
  const visible = groups.recent.slice(0, quota)
  const move = (sessionId: SessionId, beforeId?: SessionId): void => {
    const remaining = groups.recent.filter(id => id !== sessionId)
    const index = beforeId === undefined ? remaining.length : remaining.indexOf(beforeId)
    if (index < 0 || sessionId === beforeId) return
    props.actions.setRecentOrder([...remaining.slice(0, index), sessionId, ...remaining.slice(index)])
    props.actions.moveSessionToSidebarSection(sessionId, undefined, beforeId)
  }
  return <>
    {props.wide && <SidebarSectionFrame {...props} title={props.t('section.recent')} sectionId="recent"
      expanded={!organization.recentCollapsed} onToggle={() => { props.actions.setRecentCollapsed(!organization.recentCollapsed) }}
      onNew={() => { props.startSession() }} onAppend={move} trailing={<>
        <Tooltip label={props.t('sidebar.search')} side="bottom" portal>
          <button type="button" className={css.iconButton} aria-label={props.t('sidebar.search')} data-sidebar-search-trigger=""
            onClick={props.requestSearch}><IconSearchOutlineRegular size={16} /></button>
        </Tooltip>
        <SidebarFilterMenu {...props} />
      </>}
      menuItems={[
        { id: 'organize', label: props.t('sidebar.organize'), submenu: [
          { id: 'group:workspace', label: props.t('sidebar.groupBy.workspace') },
          { id: 'group:flat', label: props.t('sidebar.groupBy.flat') },
        ] },
        { id: 'sort', label: props.t('sidebar.sort'), submenu: [
          { id: 'sort:updated', label: props.t('sidebar.sort.updated') },
          { id: 'sort:manual', label: props.t('sidebar.sort.manual') },
        ] },
        { type: 'label', id: 'labels', text: props.t('sidebar.labels') },
        { id: 'labels:projects', label: props.t('sidebar.labels.projects') },
        { type: 'separator', id: 'section-divider' },
        { id: 'new-section', label: props.t('sidebar.newSection') },
      ]}
      selectedIds={[
        groupBy === 'flat' && !organization.showProjects ? 'group:flat' : 'group:workspace',
        `sort:${organization.recentSort}`,
        ...organization.showProjects ? ['labels:projects'] : [],
      ]}
      onMenuSelect={(id) => {
        if (id === 'new-section') props.requestSidebarSection()
        else if (id === 'group:workspace' || id === 'group:flat') {
          props.actions.setGroupBy(id === 'group:workspace' ? 'workspace' : 'flat')
          props.actions.setShowProjects(id === 'group:workspace')
        } else if (id === 'sort:updated' || id === 'sort:manual') {
          props.actions.setRecentSort(id === 'sort:updated' ? 'updated' : 'manual', groups.recent)
        } else if (id === 'labels:projects') {
          if (!organization.showProjects && groupBy === 'flat') props.actions.setGroupBy('workspace')
          props.actions.setShowProjects(!organization.showProjects)
        }
      }}>
      <div className={css.dropArea}>
        <SidebarSessionRows {...props} sessionIds={visible} source="recent" onMove={move} archivedFilter={archivedFilter} />
      </div>
      {groups.recent.length > quota && <button type="button" className={css.showMore}
        onClick={() => { setQuota(value => value + PAGE_SIZE) }}>{props.t('sidebar.showMore')}</button>}
      {quota > PAGE_SIZE && groups.recent.length > PAGE_SIZE && <button type="button" className={css.showMore}
        onClick={() => { setQuota(PAGE_SIZE) }}>{props.t('sidebar.showLess')}</button>}
    </SidebarSectionFrame>}
  </>
}

/** Global creation request host; it stays mounted even when search or the rail hides Recent. */
export function SidebarSectionCreateDialog(props: SidebarSectionsProps) {
  const request = props.useSidebarSectionRequest(state => state)
  const organization = props.useStore(sidebarOrganizationOf)
  return request === null ? null : <SidebarSectionNameDialog key={request.sequence} t={props.t}
    title={props.t('sidebar.newSection')} existingNames={organization.sections.map(section => section.title)}
    onClose={props.closeSidebarSectionRequest} onSave={(title) => {
      const id = randomUUID()
      props.actions.createSidebarSection(id, title)
      if (request.sessionId !== undefined) props.actions.moveSessionToSidebarSection(request.sessionId, id)
      props.closeSidebarSectionRequest()
    }} />
}

/** Archived visibility remains a separate control beside the Recent menu. */
function SidebarFilterMenu(props: SidebarSectionsProps) {
  const [open, setOpen] = useState(false)
  const filter = props.useStore(state => state.archivedFilter ?? 'default')
  return <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus align="end"
    selectedId={filter} items={[
      { id: 'default', label: props.t('viewOptions.hideArchived'), icon: <IconArchiveOffOutlineRegular /> },
      { id: 'show', label: props.t('viewOptions.showArchived'), icon: <IconQueueOutlineRegular /> },
      { id: 'only', label: props.t('viewOptions.onlyArchived'), icon: <IconArchiveCheckOutlineRegular /> },
    ]} onSelect={(id) => {
      if (id === 'default' || id === 'show' || id === 'only') props.actions.setArchivedFilter(id)
      setOpen(false)
    }} anchor={<Tooltip label={props.t('sidebar.filter')} side="bottom" portal>
      <button type="button" className={css.iconButton} aria-haspopup="menu" aria-expanded={open}
        aria-label={props.t('sidebar.filter')} onClick={() => { setOpen(value => !value) }}>
        <IconSlidersTwoOutlineRegular size={16} />
      </button>
    </Tooltip>} />
}
