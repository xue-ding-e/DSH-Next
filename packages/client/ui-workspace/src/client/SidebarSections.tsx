/** Sidebar section headings, custom groups, and the global pinned conversation projection. */
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconNewChatOutlineRegular,
  Input, Menu, Modal, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import { deriveSidebarGroups, sidebarOrganizationOf, type SidebarSection } from './sidebar-organization.ts'
import { isSidebarSessionDrag, sidebarSessionDrop, SidebarSessionRows, type SidebarSessionProps } from './SidebarSessionRows.tsx'
import css from './SidebarSections.module.css'

/** Framework data and viewing actions shared by the three sidebar projections. */
export type SidebarSectionsProps = SidebarSessionProps & Pick<WorkspaceBrowserProps,
  'wide' | 'useStore' | 'actions' | 'startSession' | 'requestSidebarSection'
  | 'useSidebarSectionRequest' | 'closeSidebarSectionRequest' | 'requestSearch'>

/**
 * Render a collapsible heading and its content in the same scrolling list.
 * @param props - section identity, expanded state, menu actions and content.
 * @returns the section with portaled menus and independent header hit targets.
 */
export function SidebarSectionFrame({ title, sectionId, expanded, onToggle, onNew, menuItems = [], selectedIds,
  onMenuSelect, children, trailing, onAppend, ...props }: Pick<SidebarSectionsProps, 't' | 'useSessions'> & {
    title: string
    sectionId: string
    expanded: boolean
    onToggle: () => void
    onNew?: (() => void) | undefined
    menuItems?: readonly MenuEntry[]
    selectedIds?: readonly string[] | undefined
    onMenuSelect?: ((id: string) => void) | undefined
    children: ReactNode
    trailing?: ReactNode
    onAppend?: ((sessionId: SessionId) => void) | undefined
  }) {
  const headingId = useId()
  const bodyId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const list = props.useSessions(state => state)
  return <section className={clsx(css.section, !expanded && css.collapsed)} aria-labelledby={headingId}
    data-sidebar-section={sectionId} data-sidebar-recent={sectionId === 'recent' ? '' : undefined}>
    <div className={css.header} data-sidebar-section-header="">
      <button type="button" id={headingId} className={css.heading} aria-expanded={expanded} aria-controls={bodyId}
        onClick={onToggle}>
        <span className={css.headingText}>{title}</span>
        <IconChevronDownOutlineRegular className={css.chevron} size={12} />
      </button>
      <span className={css.headerActions}>
        {menuItems.length > 0 && <Menu open={menuOpen} onClose={() => { setMenuOpen(false) }} portal autoFocus
          items={menuItems} selectedIds={selectedIds} listClassName={css.menu} align="end"
          onSelect={(id) => { onMenuSelect?.(id); setMenuOpen(false) }}
          anchor={<Tooltip label={props.t('sidebar.section.actions', { name: title })} side="bottom" portal>
            <button type="button" className={css.iconButton} aria-label={props.t('sidebar.section.actions', { name: title })}
              aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value) }}>
              <IconEllipsisOutlineRegular size={16} />
            </button>
          </Tooltip>} />}
        {trailing}
        {onNew !== undefined && <Tooltip label={props.t('actions.newSession')} side="bottom" portal>
          <button type="button" className={css.iconButton} aria-label={props.t('actions.newSession')} onClick={onNew}>
            <IconNewChatOutlineRegular size={16} />
          </button>
        </Tooltip>}
      </span>
    </div>
    <div id={bodyId} className={css.body} aria-hidden={!expanded}
      onDragOver={onAppend === undefined ? undefined : (event) => {
        if (!isSidebarSessionDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={onAppend === undefined ? undefined : (event) => {
        if (!isSidebarSessionDrag(event)) return
        event.preventDefault()
        event.stopPropagation()
        const dropped = sidebarSessionDrop(event, list)
        if (dropped !== undefined && (sectionId !== 'pinned' || dropped.source === 'pinned')) onAppend(dropped.sessionId)
      }}>
      <div className={css.bodyClip}>{children}</div>
    </div>
  </section>
}

/** Complete-order move for the local pinned projection, including entries outside the current visible quota. */
function reordered(ids: readonly SessionId[], sessionId: SessionId, beforeId?: SessionId): SessionId[] {
  if (!ids.includes(sessionId) || sessionId === beforeId) return [...ids]
  const remaining = ids.filter(id => id !== sessionId)
  const index = beforeId === undefined ? remaining.length : remaining.indexOf(beforeId)
  if (index < 0) return [...ids]
  return [...remaining.slice(0, index), sessionId, ...remaining.slice(index)]
}

/** Global pin set rendered before Projects, without changing Workspace membership. */
export function PinnedSessions(props: SidebarSectionsProps) {
  const list = props.useSessions(state => state)
  const archived = props.useWorkspaces(state => state.archivedSessionIds)
  const pinned = props.useWorkspaces(state => state.pinnedSessionIds)
  const organization = props.useStore(sidebarOrganizationOf)
  const groups = useMemo(() => deriveSidebarGroups(list, archived, pinned, organization), [list, archived, pinned, organization])
  if (!props.wide || groups.pinned.length === 0) return null
  const move = (sessionId: SessionId, beforeId?: SessionId): void => {
    props.actions.setSidebarPinnedOrder(reordered(groups.pinned, sessionId, beforeId))
  }
  return <SidebarSectionFrame {...props} title={props.t('section.pinned')} sectionId="pinned"
    expanded={!organization.pinnedCollapsed} onToggle={() => { props.actions.setPinnedCollapsed(!organization.pinnedCollapsed) }}
    onAppend={move}>
    <SidebarSessionRows {...props} sessionIds={groups.pinned} source="pinned" onMove={move} />
  </SidebarSectionFrame>
}

/** Custom sections share the global Session menu and retain their content when deleted. */
export function SidebarCustomSections(props: SidebarSectionsProps) {
  const list = props.useSessions(state => state)
  const archived = props.useWorkspaces(state => state.archivedSessionIds)
  const pinned = props.useWorkspaces(state => state.pinnedSessionIds)
  const organization = props.useStore(sidebarOrganizationOf)
  const groups = useMemo(() => deriveSidebarGroups(list, archived, pinned, organization), [list, archived, pinned, organization])
  const [editing, setEditing] = useState<SidebarSection | null>(null)
  const [deleting, setDeleting] = useState<SidebarSection | null>(null)
  const canCreate = props.useWorkspaces(state => state.phase === 'ready' && state.items.length > 0)
  if (!props.wide) return null
  return <>
    {groups.sections.map(({ section, sessionIds }, index) => {
      const move = (sessionId: SessionId, beforeId?: SessionId): void => {
        props.actions.moveSessionToSidebarSection(sessionId, section.id, beforeId)
      }
      return <SidebarSectionFrame key={section.id} {...props} title={section.title} sectionId={section.id}
        expanded={!section.collapsed} onToggle={() => { props.actions.setSidebarSectionCollapsed(section.id, !section.collapsed) }}
        onAppend={move} onNew={!canCreate ? undefined : () => {
          props.startSession(undefined, { beforeOpen: (sessionId) => {
            props.actions.moveSessionToSidebarSection(sessionId, section.id)
          } })
        }}
        menuItems={[
          { id: 'rename', label: props.t('sidebar.section.rename') },
          { id: 'up', label: props.t('sidebar.section.moveUp'), disabled: index === 0 },
          { id: 'down', label: props.t('sidebar.section.moveDown'), disabled: index === groups.sections.length - 1 },
          { type: 'separator', id: 'delete-divider' },
          { id: 'delete', label: props.t('sidebar.section.delete'), danger: true },
        ]}
        onMenuSelect={(id) => {
          if (id === 'rename') setEditing(section)
          else if (id === 'delete') setDeleting(section)
          else if (id === 'up') props.actions.insertSidebarSectionBefore(section.id, groups.sections[index - 1]?.section.id)
          else if (id === 'down') props.actions.insertSidebarSectionBefore(section.id, groups.sections[index + 2]?.section.id)
        }}>
        <div className={css.dropArea}>
          {sessionIds.length === 0 ? <p className={css.empty}>{props.t('sidebar.section.empty')}</p>
            : <SidebarSessionRows {...props} sessionIds={sessionIds} source={section.id} onMove={move} />}
        </div>
      </SidebarSectionFrame>
    })}
    {editing !== null && <SidebarSectionNameDialog key={editing.id} t={props.t}
      title={props.t('sidebar.section.rename')} initialTitle={editing.title}
      existingNames={organization.sections.filter(section => section.id !== editing.id).map(section => section.title)}
      onClose={() => { setEditing(null) }} onSave={(title) => {
        props.actions.renameSidebarSection(editing.id, title)
        setEditing(null)
      }} />}
    {deleting !== null && <Modal open title={props.t('sidebar.section.delete')} closeLabel={props.t('close')}
      description={props.t('sidebar.section.deleteDescription', { name: deleting.title })}
      onClose={() => { setDeleting(null) }} footer={<>
        <Button variant="outline" onClick={() => { setDeleting(null) }}>{props.t('cancel')}</Button>
        <Button variant="primary" onClick={() => {
          props.actions.deleteSidebarSection(deleting.id)
          setDeleting(null)
        }}>{props.t('sidebar.section.delete')}</Button>
      </>} />}
  </>
}

/** Captured section-name form; keyboard composition never submits the unfinished name. */
export function SidebarSectionNameDialog({ title, initialTitle = '', existingNames, onSave, onClose, t }:
  Pick<SidebarSectionsProps, 't'> & {
    title: string
    initialTitle?: string
    existingNames: readonly string[]
    onSave: (title: string) => void
    onClose: () => void
  }) {
  const [draft, setDraft] = useState(initialTitle)
  const composing = useRef(false)
  const trimmed = draft.trim()
  const duplicate = existingNames.some(name => name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase())
  const blocked = trimmed === '' || duplicate
  const save = (): void => { if (!blocked) onSave(trimmed) }
  return <Modal open title={title} closeLabel={t('close')} onClose={onClose} footer={<>
    <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
    <Button variant="primary" disabled={blocked} onClick={save}>{t('save')}</Button>
  </>}>
    <Input className={css.sectionInput ?? ''} data-modal-autofocus aria-label={t('sidebar.section.name')}
      value={draft} onFocus={(event) => { event.currentTarget.select() }} onChange={(event) => { setDraft(event.currentTarget.value) }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || composing.current || event.nativeEvent.isComposing) return
        event.preventDefault()
        save()
      }} />
    {duplicate && <p className={css.dialogError} role="alert">{t('sidebar.section.duplicate')}</p>}
  </Modal>
}
