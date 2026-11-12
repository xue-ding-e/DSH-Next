// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  deriveSidebarGroups, sidebarOrganizationOf, type SidebarOrganization, type SidebarSection,
} from '../src/client/sidebar-organization.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

const row = (id: string, updatedAt: number, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: SessionId(id), displayTitle: id, blank: false, running: false, retainedBy: {}, updatedAt, ...patch,
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready', projectionsBySession: {},
})
const section = (id: string, ...sessionIds: string[]): SidebarSection => ({ id, title: id, collapsed: false, sessionIds })
const organization = (patch: Partial<SidebarOrganization> = {}): SidebarOrganization => ({
  ...sidebarOrganizationOf({}), recentOrder: [], pinnedOrder: [], sections: [], ...patch,
})
const createStore = () => createWorkspaceViewStore().create('organization-tests')
const preferences = (store: ReturnType<typeof createStore>) => sidebarOrganizationOf(store.getSnapshot())

afterEach(() => { localStorage.clear() })

describe('sidebar organization projection', () => {
  it('uses stable defaults for historical snapshots and leaves them immutable', () => {
    const first = sidebarOrganizationOf({})
    expect(sidebarOrganizationOf({})).toBe(first)
    expect(first).toEqual({
      recentCollapsed: false, pinnedCollapsed: false, projectsCollapsed: false,
      showProjects: true, recentSort: 'updated', recentOrder: [], pinnedOrder: [], sections: [],
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.sections)).toBe(true)
    expect(Object.isFrozen(first.recentOrder)).toBe(true)
    expect(Object.isFrozen(first.pinnedOrder)).toBe(true)
    const saved = organization({ showProjects: false })
    expect(sidebarOrganizationOf({ sidebar: saved })).toBe(saved)
  })

  it('keeps pins above sections and restores their membership after unpinning', () => {
    const sessions = list(row('p', 1), row('assigned', 2), row('recent', 3))
    const saved = organization({ sections: [section('work', 'assigned', 'p')] })
    const pinned = deriveSidebarGroups(sessions, [], [SessionId('p')], saved)
    expect(pinned.pinned).toEqual(['p'])
    expect(pinned.sections[0]?.sessionIds).toEqual(['assigned'])
    expect(pinned.recent).toEqual(['recent'])
    expect(saved.sections[0]?.sessionIds).toEqual(['assigned', 'p'])
    expect(deriveSidebarGroups(sessions, [], [], saved).sections[0]?.sessionIds).toEqual(['assigned', 'p'])
  })

  it('filters blank, archived, subagent and absent rows without discarding saved references', () => {
    const sessions = list(row('a', 1), row('b', 2), row('blank', 9, { blank: true }),
      row('child', 8, { origin: 'subagent' }), row('archive', 7))
    sessions.ids.push(SessionId('absent'))
    const saved = organization({ sections: [section('first', 'a', 'a', 'missing'), section('second', 'a', 'b')] })
    const result = deriveSidebarGroups(sessions, [SessionId('archive')], [SessionId('blank'), SessionId('archive')], saved)
    expect(result.pinned).toEqual([])
    expect(result.sections.map(group => group.sessionIds)).toEqual([['a'], ['b']])
    expect(result.recent).toEqual([])
    expect(saved.sections[0]?.sessionIds).toEqual(['a', 'a', 'missing'])
    expect(deriveSidebarGroups(list(row('missing', 10)), [], [], saved).sections[0]?.sessionIds).toEqual(['missing'])
  })

  it('sorts updates independently of opening history and keeps all recent conversations', () => {
    const sessions = list(row('z', 10), row('b', 20), row('a', 20), row('c', 3), row('d', 4), row('e', 5))
    expect(deriveSidebarGroups(sessions, [], [], organization()).recent).toEqual(['a', 'b', 'z', 'e', 'd', 'c'])
    const manual = organization({ recentSort: 'manual', recentOrder: ['z', 'missing', 'z', 'b'] })
    expect(deriveSidebarGroups(sessions, [], [], manual).recent).toEqual(['z', 'b', 'a', 'e', 'd', 'c'])
  })

  it('uses saved pin order only within current pins and retains membership while collapsed', () => {
    const sessions = list(row('a', 1), row('b', 2), row('c', 3), row('d', 4))
    const saved = organization({
      pinnedOrder: ['c', 'a', 'c', 'unknown'], recentCollapsed: true, pinnedCollapsed: true,
      projectsCollapsed: true, showProjects: false, sections: [{ ...section('section', 'd'), collapsed: true }],
    })
    const result = deriveSidebarGroups(sessions, [], [SessionId('a'), SessionId('b'), SessionId('c')], saved)
    expect(result.pinned).toEqual(['c', 'a', 'b'])
    expect(result.sections[0]?.sessionIds).toEqual(['d'])
    expect(result.sections[0]?.section).toBe(saved.sections[0])
    expect(result.recent).toEqual([])
  })

  it('keeps custom memberships and manual orders through an empty catalog and reload', () => {
    const store = createStore()
    store.actions.createSidebarSection('saved', 'Saved')
    store.actions.moveSessionToSidebarSection(SessionId('assigned'), 'saved')
    store.actions.setRecentOrder(['older', 'newer'])
    store.actions.setSidebarPinnedOrder(['pinned'])
    const before = preferences(store)
    expect(deriveSidebarGroups(list(), [], [], before)).toEqual({
      pinned: [], sections: [{ section: before.sections[0], sessionIds: [] }], recent: [],
    })
    expect(preferences(store)).toBe(before)
    const reloaded = createStore()
    const restored = deriveSidebarGroups(list(row('assigned', 1), row('older', 2), row('newer', 9), row('pinned', 3)),
      [], [SessionId('pinned')], preferences(reloaded))
    expect(restored.pinned).toEqual(['pinned'])
    expect(restored.sections[0]?.sessionIds).toEqual(['assigned'])
    expect(restored.recent).toEqual(['older', 'newer'])
  })
})

describe('persisted sidebar organization actions', () => {
  it('rehydrates a historical v5 snapshot and preserves its existing view state', () => {
    const historical = {
      groupBy: 'workspace-tree', orderBy: 'manual', groupExpansion: { workspace: true },
      sessionOrderByAccount: { workspace: ['old'] }, openedAt: { old: 123 },
    }
    localStorage.setItem('dsh.workspace.view.v5.organization-tests', JSON.stringify(historical))
    const store = createStore()
    expect(store.getSnapshot()).toEqual(historical)
    expect(preferences(store)).toBe(sidebarOrganizationOf({}))
    store.actions.setRecentCollapsed(true)
    store.actions.setPinnedCollapsed(true)
    store.actions.setProjectsCollapsed(true)
    store.actions.setShowProjects(false)
    expect(store.getSnapshot()).toMatchObject(historical)
    const reloaded = createStore()
    expect(preferences(reloaded)).toMatchObject({
      recentCollapsed: true, pinnedCollapsed: true, projectsCollapsed: true, showProjects: false,
    })
    expect(sidebarOrganizationOf({}).recentCollapsed).toBe(false)
  })

  it('captures the current order on switching to manual and preserves temporarily absent references', () => {
    const store = createStore()
    store.actions.setRecentSort('manual', ['b', 'a', 'b', 'offline'])
    expect(preferences(store).recentOrder).toEqual(['b', 'a', 'offline'])
    store.actions.setRecentSort('manual', ['a', 'b'])
    expect(preferences(store).recentOrder).toEqual(['b', 'a', 'offline'])
    store.actions.setRecentOrder(['a', 'b'])
    expect(preferences(store).recentOrder).toEqual(['a', 'b', 'offline'])
    store.actions.setRecentSort('updated', [])
    store.actions.setRecentSort('manual', ['b', 'new', 'a'])
    expect(preferences(store).recentOrder).toEqual(['b', 'new', 'a', 'offline'])
    expect(deriveSidebarGroups(list(row('a', 9), row('b', 8), row('offline', 7)), [], [], preferences(store)).recent)
      .toEqual(['b', 'a', 'offline'])
  })

  it('moves a Session between sections atomically and deletes only the view section', () => {
    const store = createStore()
    store.actions.createSidebarSection('first', 'First')
    store.actions.createSidebarSection('second', 'Second')
    store.actions.moveSessionToSidebarSection(SessionId('a'), 'first')
    store.actions.moveSessionToSidebarSection(SessionId('b'), 'second')
    store.actions.moveSessionToSidebarSection(SessionId('a'), 'second', SessionId('b'))
    expect(preferences(store).sections.map(item => item.sessionIds)).toEqual([[], ['a', 'b']])
    store.actions.renameSidebarSection('second', 'Renamed')
    store.actions.setSidebarSectionCollapsed('second', true)
    expect(preferences(store).sections[1]).toEqual({ id: 'second', title: 'Renamed', collapsed: true, sessionIds: ['a', 'b'] })
    store.actions.deleteSidebarSection('second')
    expect(preferences(store).sections.map(item => item.id)).toEqual(['first'])
    expect(deriveSidebarGroups(list(row('a', 1), row('b', 2)), [], [], preferences(store)).recent).toEqual(['b', 'a'])
    expect(store.getSnapshot().sessionOrderByAccount).toEqual({})
  })

  it('returns a conversation to recent and reorders only members of the selected section', () => {
    const store = createStore()
    store.actions.createSidebarSection('work', 'Work')
    for (const id of ['a', 'b', 'temporarily-absent']) store.actions.moveSessionToSidebarSection(SessionId(id), 'work')
    store.actions.setSidebarSectionOrder('work', ['b', 'outsider', 'b', 'a'])
    expect(preferences(store).sections[0]?.sessionIds).toEqual(['b', 'a', 'temporarily-absent'])
    store.actions.setRecentOrder(['older', 'newer'])
    store.actions.moveSessionToSidebarSection(SessionId('a'), undefined, SessionId('newer'))
    expect(preferences(store).sections[0]?.sessionIds).toEqual(['b', 'temporarily-absent'])
    expect(preferences(store).recentOrder).toEqual(['older', 'a', 'newer'])
    const reloaded = createStore()
    expect(preferences(reloaded)).toEqual(preferences(store))
    reloaded.actions.retainAccountKeys(['real-workspace'])
    expect(preferences(reloaded).sections[0]?.sessionIds).toEqual(['b', 'temporarily-absent'])
  })

  it('ignores stale section targets and anchors without removing an existing assignment', () => {
    const store = createStore()
    store.actions.createSidebarSection('first', 'First')
    store.actions.createSidebarSection('second', 'Second')
    store.actions.moveSessionToSidebarSection(SessionId('a'), 'first')
    const before = preferences(store)
    store.actions.moveSessionToSidebarSection(SessionId('a'), 'missing')
    store.actions.moveSessionToSidebarSection(SessionId('a'), 'second', SessionId('missing'))
    store.actions.moveSessionToSidebarSection(SessionId('a'), 'first', SessionId('a'))
    store.actions.renameSidebarSection('missing', 'No effect')
    store.actions.setSidebarSectionCollapsed('missing', true)
    store.actions.setSidebarSectionOrder('missing', ['a'])
    store.actions.deleteSidebarSection('missing')
    store.actions.insertSidebarSectionBefore('first', 'missing')
    store.actions.insertSidebarSectionBefore('missing', 'first')
    expect(preferences(store)).toBe(before)
  })

  it('retains stable section identities while renaming, moving and pin ordering', () => {
    const store = createStore()
    for (const id of ['a', 'b', 'c']) store.actions.createSidebarSection(id, 'Same name')
    store.actions.createSidebarSection('a', 'Duplicate id')
    store.actions.insertSidebarSectionBefore('c', 'a')
    expect(preferences(store).sections.map(item => item.id)).toEqual(['c', 'a', 'b'])
    store.actions.insertSidebarSectionBefore('a')
    expect(preferences(store).sections.map(item => item.id)).toEqual(['c', 'b', 'a'])
    store.actions.insertSidebarSectionBefore('b', 'b')
    expect(preferences(store).sections.map(item => item.id)).toEqual(['c', 'b', 'a'])
    store.actions.setSidebarPinnedOrder(['b', 'a', 'offline'])
    store.actions.setSidebarPinnedOrder(['a', 'b', 'a'])
    expect(preferences(store).pinnedOrder).toEqual(['a', 'b', 'offline'])
    expect(preferences(store).sections.every(item => item.title === 'Same name')).toBe(true)
  })
})
