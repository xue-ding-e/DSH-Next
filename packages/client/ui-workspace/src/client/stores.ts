/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { reconcileManualOrder, type ArchivedFilter, type SessionRowState } from './tree.ts'
import { sidebarOrganizationOf, type SidebarOrganization } from './sidebar-organization.ts'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** Session-list grouping mode: sibling Workspace sections, a Workspace tree, or one flat list. */
export type SessionGroupBy = 'workspace' | 'workspace-tree' | 'flat'
/** Session order: saved manual positions or current recency. */
export type SessionOrderBy = 'manual' | 'updated'

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Explicit group expansion keyed by Workspace identity, including descendants in tree mode. */
  groupExpansion: Record<string, boolean>
  /** Saved manual order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Archived-row visibility; omitted in pre-filter v5 snapshots and read as 'default'. */
  archivedFilter?: ArchivedFilter
  /** Latest navigation time per Session, retained across reloads on this device. */
  openedAt?: Record<string, number>
  /** Sidebar-only organization; absent in historical v5 snapshots. */
  sidebar?: SidebarOrganization
}

type SessionOrderSource = {
  members: Readonly<Record<string, readonly SessionId[]>>
  summaries: SessionListState['byId']
  rowState: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (
    draft: WorkspaceViewState,
    mode: SessionOrderBy,
    initialOrders: Readonly<Record<string, readonly string[]>>,
  ) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrders: (
    draft: WorkspaceViewState,
    orders: Readonly<Record<string, readonly string[]>>,
  ) => void
  setSessionOrder: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: readonly string[],
    initialOrders: Readonly<Record<string, readonly string[]>>,
  ) => void
  pinSessionOrder: (
    draft: WorkspaceViewState,
    sessionId: string,
    accountKeys: readonly string[],
    source: SessionOrderSource,
  ) => void
  setArchivedFilter: (draft: WorkspaceViewState, filter: ArchivedFilter) => void
  recordOpened: (draft: WorkspaceViewState, sessionId: SessionId, time: number) => void
  setRecentCollapsed: (draft: WorkspaceViewState, collapsed: boolean) => void
  setPinnedCollapsed: (draft: WorkspaceViewState, collapsed: boolean) => void
  setProjectsCollapsed: (draft: WorkspaceViewState, collapsed: boolean) => void
  setShowProjects: (draft: WorkspaceViewState, show: boolean) => void
  setRecentSort: (draft: WorkspaceViewState, mode: SidebarOrganization['recentSort'], initialOrder: readonly string[]) => void
  setRecentOrder: (draft: WorkspaceViewState, order: readonly string[]) => void
  setSidebarPinnedOrder: (draft: WorkspaceViewState, order: readonly string[]) => void
  createSidebarSection: (draft: WorkspaceViewState, id: string, title: string) => void
  renameSidebarSection: (draft: WorkspaceViewState, id: string, title: string) => void
  deleteSidebarSection: (draft: WorkspaceViewState, id: string) => void
  setSidebarSectionCollapsed: (draft: WorkspaceViewState, id: string, collapsed: boolean) => void
  insertSidebarSectionBefore: (draft: WorkspaceViewState, id: string, beforeId?: string) => void
  moveSessionToSidebarSection: (draft: WorkspaceViewState, sessionId: SessionId, sectionId?: string, beforeSessionId?: SessionId) => void
  setSidebarSectionOrder: (draft: WorkspaceViewState, id: string, order: readonly string[]) => void
}

/** Copy read-only projections into the persisted mutable store representation. */
function copySessionOrders(
  orders: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(orders).map(([key, order]) => [key, [...order]]))
}

/** Create mutable defaults only when an action first changes a historical snapshot. */
function ensureSidebar(draft: WorkspaceViewState): SidebarOrganization {
  return draft.sidebar ??= {
    ...sidebarOrganizationOf(draft), recentOrder: [], pinnedOrder: [], sections: [],
  }
}

/** A visible reorder preserves references absent from the current catalog. */
function preserveSidebarOrder(order: readonly string[], saved: readonly string[]): string[] {
  return [...new Set([...order, ...saved])]
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      archivedFilter: 'default',
    }),
    persist: 'dsh.workspace.view.v5',
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy, initialOrders) => {
        if (mode === d.orderBy) return
        d.sessionOrderByAccount = mode === 'manual' ? copySessionOrders(initialOrders) : {}
        d.orderBy = mode
      },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
        )
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        )
        delete (d as WorkspaceViewState & { sessionUpdatedAtByAccount?: unknown }).sessionUpdatedAtByAccount
      },
      syncSessionOrders: (d, orders) => {
        if (d.orderBy !== 'manual') return
        Object.assign(d.sessionOrderByAccount, copySessionOrders(orders))
      },
      setSessionOrder: (d, accountKey, order, initialOrders) => {
        if (d.orderBy === 'updated') d.sessionOrderByAccount = copySessionOrders(initialOrders)
        else Object.assign(d.sessionOrderByAccount, copySessionOrders(initialOrders))
        d.orderBy = 'manual'
        d.sessionOrderByAccount[accountKey] = [...order]
      },
      pinSessionOrder: (d, sessionId, accountKeys, source) => {
        const selected = new Set(accountKeys)
        d.sessionOrderByAccount = Object.fromEntries(Object.entries(source.members).map(([key, members]) => {
          const order = reconcileManualOrder(members, d.sessionOrderByAccount[key], source.summaries, source.rowState)
          return [key, selected.has(key) ? [sessionId, ...order.filter(id => id !== sessionId)] : order]
        }))
      },
      setArchivedFilter: (d, filter: ArchivedFilter) => { d.archivedFilter = filter },
      recordOpened: (d, sessionId, time) => { (d.openedAt ??= {})[sessionId] = time },
      setRecentCollapsed: (d, collapsed) => { ensureSidebar(d).recentCollapsed = collapsed },
      setPinnedCollapsed: (d, collapsed) => { ensureSidebar(d).pinnedCollapsed = collapsed },
      setProjectsCollapsed: (d, collapsed) => { ensureSidebar(d).projectsCollapsed = collapsed },
      setShowProjects: (d, show) => { ensureSidebar(d).showProjects = show },
      setRecentSort: (d, mode, initialOrder) => {
        const sidebar = ensureSidebar(d)
        if (mode === sidebar.recentSort) return
        if (mode === 'manual') sidebar.recentOrder = preserveSidebarOrder(initialOrder, sidebar.recentOrder)
        sidebar.recentSort = mode
      },
      setRecentOrder: (d, order) => {
        const sidebar = ensureSidebar(d)
        sidebar.recentSort = 'manual'
        sidebar.recentOrder = preserveSidebarOrder(order, sidebar.recentOrder)
      },
      setSidebarPinnedOrder: (d, order) => {
        const sidebar = ensureSidebar(d)
        sidebar.pinnedOrder = preserveSidebarOrder(order, sidebar.pinnedOrder)
      },
      createSidebarSection: (d, id, title) => {
        const sidebar = ensureSidebar(d)
        if (sidebar.sections.some(section => section.id === id)) return
        sidebar.sections.push({ id, title, collapsed: false, sessionIds: [] })
      },
      renameSidebarSection: (d, id, title) => {
        const section = d.sidebar?.sections.find(section => section.id === id)
        if (section !== undefined) section.title = title
      },
      deleteSidebarSection: (d, id) => {
        const sections = d.sidebar?.sections
        const index = sections?.findIndex(section => section.id === id)
        if (sections !== undefined && index !== undefined && index !== -1) sections.splice(index, 1)
      },
      setSidebarSectionCollapsed: (d, id, collapsed) => {
        const section = d.sidebar?.sections.find(section => section.id === id)
        if (section !== undefined) section.collapsed = collapsed
      },
      insertSidebarSectionBefore: (d, id, beforeId) => {
        const sidebar = d.sidebar
        if (sidebar === undefined) return
        const sections = sidebar.sections
        const section = sections.find(section => section.id === id)
        if (section === undefined || id === beforeId) return
        if (beforeId !== undefined && !sections.some(section => section.id === beforeId)) return
        const rest = sections.filter(section => section.id !== id)
        rest.splice(beforeId === undefined ? rest.length : rest.findIndex(section => section.id === beforeId), 0, section)
        sidebar.sections = rest
      },
      moveSessionToSidebarSection: (d, sessionId, sectionId, beforeSessionId) => {
        const sidebar = d.sidebar
        if (sidebar === undefined || sessionId === beforeSessionId) return
        const destination = sectionId === undefined ? undefined : sidebar.sections.find(section => section.id === sectionId)
        if (sectionId !== undefined && destination === undefined) return
        const order = destination?.sessionIds ?? sidebar.recentOrder
        if (beforeSessionId !== undefined && !order.includes(beforeSessionId)) return
        const next = order.filter(id => id !== sessionId)
        next.splice(beforeSessionId === undefined ? next.length : next.indexOf(beforeSessionId), 0, sessionId)
        for (const section of sidebar.sections) section.sessionIds = section.sessionIds.filter(id => id !== sessionId)
        if (destination === undefined) sidebar.recentOrder = next
        else destination.sessionIds = next
      },
      setSidebarSectionOrder: (d, id, order) => {
        const section = d.sidebar?.sections.find(section => section.id === id)
        if (section === undefined) return
        const members = new Set(section.sessionIds)
        section.sessionIds = preserveSidebarOrder(order.filter(id => members.has(id)), section.sessionIds)
      },
    },
  })
}

/** The bound write set of one viewing-store instance (what the UiWorkspace service drives). */
export type WorkspaceViewStoreActions = ReturnType<ReturnType<typeof createWorkspaceViewStore>['create']>['actions']
