/** Device-local sidebar organization over references to existing Sessions. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { orderByRecency, reconcileManualOrder, visibleSessionIds } from './tree.ts'

/** One named, ordered sidebar section; membership never changes a Session's Workspace. */
export interface SidebarSection {
  id: string
  title: string
  collapsed: boolean
  sessionIds: string[]
}

/** Presentation preferences and manual reference orders persisted with the Workspace view. */
export interface SidebarOrganization {
  recentCollapsed: boolean
  pinnedCollapsed: boolean
  projectsCollapsed: boolean
  showProjects: boolean
  recentSort: 'updated' | 'manual'
  recentOrder: string[]
  pinnedOrder: string[]
  sections: SidebarSection[]
}

const defaultOrganization: SidebarOrganization = {
  recentCollapsed: false,
  pinnedCollapsed: false,
  projectsCollapsed: false,
  showProjects: true,
  recentSort: 'updated',
  recentOrder: [],
  pinnedOrder: [],
  sections: [],
}
Object.freeze(defaultOrganization.recentOrder)
Object.freeze(defaultOrganization.pinnedOrder)
Object.freeze(defaultOrganization.sections)
Object.freeze(defaultOrganization)

/**
 * Read sidebar preferences without rewriting a snapshot saved before organization existed.
 * @param state - Workspace viewing state, including historical v5 snapshots.
 * @returns saved preferences or the same immutable defaults for every absent value.
 */
export function sidebarOrganizationOf(state: { sidebar?: SidebarOrganization }): Readonly<SidebarOrganization> {
  return state.sidebar ?? defaultOrganization
}

/** Complete sidebar membership; collapse and project visibility affect rendering only. */
export interface SidebarGroups {
  pinned: SessionId[]
  sections: { section: SidebarSection; sessionIds: SessionId[] }[]
  recent: SessionId[]
}

/**
 * Derive disjoint pinned, custom-section and recent lists without changing saved memberships.
 * @param list - loaded Session catalog.
 * @param archivedSessionIds - Host-authoritative archive membership.
 * @param pinnedSessionIds - Host-authoritative pin membership and default pin order.
 * @param organization - device-local sidebar preferences.
 * @returns visible ordinary Sessions, with pins taking precedence over custom sections.
 */
export function deriveSidebarGroups(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  pinnedSessionIds: readonly SessionId[],
  organization: Readonly<SidebarOrganization>,
): SidebarGroups {
  const visible = new Set(visibleSessionIds(list, archivedSessionIds, 'default'))
  const pins = [...new Set(pinnedSessionIds)].filter(id => visible.has(id))
  const pinById = new Map(pins.map(id => [id as string, id]))
  const pinned: SessionId[] = []
  for (const id of [...organization.pinnedOrder, ...pins]) {
    const sessionId = pinById.get(id)
    if (sessionId === undefined) continue
    pinned.push(sessionId)
    pinById.delete(id)
    visible.delete(sessionId)
  }
  const sections = organization.sections.map(section => ({
    section,
    sessionIds: section.sessionIds.flatMap((id) => {
      const sessionId = list.byId[id as SessionId]?.id
      if (sessionId === undefined || !visible.delete(sessionId)) return []
      return [sessionId]
    }),
  }))
  const recent = organization.recentSort === 'manual'
    ? reconcileManualOrder([...visible], organization.recentOrder, list.byId)
    : orderByRecency([...visible], list.byId)
  return { pinned, sections, recent }
}
