// @vitest-environment jsdom
import { $getRoot } from 'lexical'
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { SessionReferenceTransfers, SESSION_REFERENCE_DRAG, stageSessionReference } from '../src/client/session-drag.ts'
import { SessionReferenceDrop } from '../src/client/SessionReferenceDrop.tsx'
import { SearchResultItem, SessionNodeItem } from '../../ui-workspace/src/client/rows/Rows.tsx'
import { zh } from '../../ui-workspace/src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'

afterEach(cleanup)
const source = SessionId('synthetic-source')
const mention = formatSessionReferenceMention({ sessionId: source, label: 'Source' })
const candidates = [{ sessionId: source, label: 'Source', mention, sameWorkspace: false, createdAt: 0 }]
function transfer() {
  const data = new Map<string, string>()
  return { getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => { data.set(type, value) }, get types() { return [...data.keys()] }, dropEffect: 'none' } as unknown as DataTransfer
}
function shell() {
  const sink = vi.fn()
  const input = new SessionInputShell({ actx: new Context(), defaultSink: sink, commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  return { input, sink }
}

it('accepts only a current application token, not forged URIs, and consumes it once', () => {
  const registry = new SessionReferenceTransfers()
  const item = transfer()
  item.setData(SESSION_REFERENCE_DRAG, mention)
  expect(registry.take(item)).toBeUndefined()
  registry.start(source, item)
  expect(registry.take(item)).toBe(source)
  expect(registry.take(item)).toBeUndefined()
  registry.start(source, item)
  registry.end()
  expect(registry.take(item)).toBeUndefined()
})

it('stages a real editor chip, deduplicates repeated drops, and never submits', async () => {
  const { input, sink } = shell()
  try {
    input.setDraft('Review ')
    expect(await stageSessionReference(input, source, async () => candidates, new AbortController().signal)).toBe('inserted')
    expect(input.state.getSnapshot().occurrences).toMatchObject([{ source: 'reference', ref: mention }])
    expect(await stageSessionReference(input, source, async () => candidates, new AbortController().signal)).toBe('duplicate')
    const renamed = [{ ...candidates[0]!, label: 'Renamed', mention: formatSessionReferenceMention({ sessionId: source, label: 'Renamed' }) }]
    expect(await stageSessionReference(input, source, async () => renamed, new AbortController().signal)).toBe('duplicate')
    expect(input.state.getSnapshot().occurrences).toHaveLength(1)
    expect(sink).not.toHaveBeenCalled()
  } finally { input.dispose() }
})

it('refuses stale draft revisions and cancelled discovery without losing user edits', async () => {
  const { input, sink } = shell()
  try {
    const gate = Promise.withResolvers<typeof candidates>()
    const pending = stageSessionReference(input, source, () => gate.promise, new AbortController().signal)
    input.setDraft('newer user draft')
    gate.resolve(candidates)
    expect(await pending).toBe('changed')
    expect(input.state.getSnapshot().draft).toBe('newer user draft')
    const controller = new AbortController()
    const gate2 = Promise.withResolvers<typeof candidates>()
    const cancelled = stageSessionReference(input, source, () => gate2.promise, controller.signal)
    controller.abort()
    gate2.resolve(candidates)
    await expect(cancelled).rejects.toThrow()
    expect(input.state.getSnapshot().occurrences).toHaveLength(0)
    expect(sink).not.toHaveBeenCalled()
  } finally { input.dispose() }
})

it('does not stage deleted or unauthorized source candidates', async () => {
  const { input } = shell()
  try {
    expect(await stageSessionReference(input, source, async () => [], new AbortController().signal)).toBe('unavailable')
    expect(input.state.getSnapshot().occurrences).toHaveLength(0)
  } finally { input.dispose() }
})

it('routes only its own composer drops and aborts pending work on unmount', () => {
  let signal: AbortSignal | undefined
  const drop = vi.fn(async (_item: DataTransfer, value: AbortSignal) => { signal = value })
  const view = render(<><div data-composer-card data-testid="own"><SessionReferenceDrop drop={drop} /></div><div data-composer-card data-testid="other" /></>)
  const item = transfer()
  item.setData(SESSION_REFERENCE_DRAG, 'synthetic-token')
  fireEvent.drop(view.getByTestId('other'), { dataTransfer: item })
  expect(drop).not.toHaveBeenCalled()
  fireEvent.drop(view.getByTestId('own'), { dataTransfer: item })
  expect(drop).toHaveBeenCalledTimes(1)
  expect(signal?.aborted).toBe(false)
  view.unmount()
  expect(signal?.aborted).toBe(true)
})


it('stages a second distinct session after an existing chip using editor coordinates', async () => {
  const { input, sink } = shell()
  try {
    expect(await stageSessionReference(input, source, async () => candidates, new AbortController().signal)).toBe('inserted')
    const second = SessionId('synthetic-second')
    const next = [{ ...candidates[0]!, sessionId: second, mention: formatSessionReferenceMention({ sessionId: second, label: 'Second' }) }]
    expect(await stageSessionReference(input, second, async () => next, new AbortController().signal)).toBe('inserted')
    expect(input.state.getSnapshot().occurrences).toHaveLength(2)
    expect(sink).not.toHaveBeenCalled()
  } finally { input.dispose() }
})


it.each([[3, 3], [3, 5]])('inserts after a middle selection %i..%i without deleting Chinese or emoji text', async (start, end) => {
  const { input, sink } = shell()
  try {
    input.setDraft('前😀中后文')
    input.editor.update(() => { $getRoot().getAllTextNodes()[0]!.select(start, end) }, { discrete: true })
    const insertion = input.actions.captureInsertion()
    expect(await stageSessionReference(input, source, async () => candidates, new AbortController().signal)).toBe('inserted')
    const current = input.state.getSnapshot()
    expect(current.occurrences[0]?.offset).toBe(insertion.end)
    expect(current.draft.replace(mention + ' ', '')).toBe('前😀中后文')
    expect(sink).not.toHaveBeenCalled()
  } finally { input.dispose() }
})


it.each(['denied', 'archived', 'unavailable', 'removed-owner'] as const)('clears a search drag token after %s rerender and dragEnd', (change) => {
  const registry = new SessionReferenceTransfers()
  let allowed = true
  let available = true
  const owner = referenceOwner(registry, () => available)
  const result = { id: source, title: 'Synthetic', workspace: 'Synthetic', running: false, runningSubagentCount: 0, completed: false, archived: false }
  const props = { result, currentId: undefined, onOpen: vi.fn(), onUnarchive: vi.fn(),
    useSessionAccess: () => allowed, t: makeTranslate(zh, commonZh) }
  const view = render(<SearchResultItem {...props} referenceDrag={owner} />)
  const item = transfer()
  fireEvent.dragStart(view.getByRole('treeitem'), { dataTransfer: item })
  expect(item.getData(SESSION_REFERENCE_DRAG)).not.toBe('')
  allowed = change !== 'denied'
  available = change !== 'unavailable'
  view.rerender(<SearchResultItem {...props} result={{ ...result, archived: change === 'archived' }}
    {...change === 'removed-owner' ? {} : { referenceDrag: owner }} />)
  fireEvent.dragEnd(view.getByRole('treeitem'), { dataTransfer: item })
  expect(owner.end).toHaveBeenCalledTimes(1)
  expect(registry.take(item)).toBeUndefined()
  expect(props.onOpen).not.toHaveBeenCalled()
})


function referenceOwner(registry: SessionReferenceTransfers, available = () => true) {
  const end = vi.fn((finish: () => boolean) => finish())
  return { available, end, start: (id: typeof source, item: DataTransfer) => {
    const finish = registry.start(id, item)
    return () => end(finish)
  } }
}

function searchDragFixture(registry = new SessionReferenceTransfers()) {
  const owner = referenceOwner(registry)
  const props = { result: { id: source, title: 'Synthetic', workspace: 'Synthetic', running: false, runningSubagentCount: 0, completed: false, archived: false }, currentId: undefined, onOpen: vi.fn(), onUnarchive: vi.fn(), useSessionAccess: () => true, t: makeTranslate(zh, commonZh) }
  return { registry, owner, props }
}

it('cleans the original owner after owner replacement without touching the new owner', () => {
  const a = searchDragFixture()
  const b = searchDragFixture()
  const view = render(<SearchResultItem {...a.props} referenceDrag={a.owner} />)
  const item = transfer()
  fireEvent.dragStart(view.getByRole('treeitem'), { dataTransfer: item })
  view.rerender(<SearchResultItem {...a.props} referenceDrag={b.owner} />)
  fireEvent.dragEnd(view.getByRole('treeitem'), { dataTransfer: item })
  expect(a.registry.take(item)).toBeUndefined()
  expect(a.owner.end).toHaveBeenCalledTimes(1)
  expect(b.owner.end).not.toHaveBeenCalled()
  view.unmount()
  expect(a.owner.end).toHaveBeenCalledTimes(1)
})

it('cleans an unmounted active row but never clears another row newer transfer', () => {
  const h = searchDragFixture()
  const view = render(<SearchResultItem {...h.props} referenceDrag={h.owner} />)
  const old = transfer()
  fireEvent.dragStart(view.getByRole('treeitem'), { dataTransfer: old })
  const newer = transfer()
  h.registry.start(source, newer)
  view.unmount()
  expect(h.registry.take(old)).toBeUndefined()
  expect(h.registry.take(newer)).toBe(source)
  expect(h.owner.end).toHaveBeenCalledTimes(1)
})

it('clears a token on unmount without needing browser dragEnd and leaves untouched rows inert', () => {
  const h = searchDragFixture()
  const view = render(<SearchResultItem {...h.props} referenceDrag={h.owner} />)
  const item = transfer()
  fireEvent.dragStart(view.getByRole('treeitem'), { dataTransfer: item })
  view.unmount()
  expect(h.registry.take(item)).toBeUndefined()
  const untouched = render(<SearchResultItem {...h.props} referenceDrag={h.owner} />)
  const other = transfer()
  h.registry.start(source, other)
  untouched.unmount()
  expect(h.owner.end).toHaveBeenCalledTimes(1)
  expect(h.registry.take(other)).toBe(source)
})

it('does not let an older row dragEnd clear a newer row generation', () => {
  const registry = new SessionReferenceTransfers()
  const a = searchDragFixture(registry)
  const b = searchDragFixture(registry)
  const first = render(<SearchResultItem {...a.props} referenceDrag={a.owner} />)
  const second = render(<SearchResultItem {...b.props} referenceDrag={b.owner} />)
  const old = browserDrag()
  const newer = browserDrag()
  const rowA = first.container.querySelector('[role="treeitem"]')!
  const rowB = second.container.querySelector('[role="treeitem"]')!
  fireEvent.dragStart(rowA, { dataTransfer: old.start })
  fireEvent.dragStart(rowB, { dataTransfer: newer.start })
  fireEvent.dragEnd(rowA, { dataTransfer: old.end })
  expect(registry.take(newer.drop)).toBe(source)
  fireEvent.dragEnd(rowB, { dataTransfer: newer.end })
  expect(a.owner.end).toHaveBeenCalledTimes(1)
  expect(b.owner.end).toHaveBeenCalledTimes(1)
})

it('keeps finish handles generation-scoped and owner disposal idempotent', () => {
  const registry = new SessionReferenceTransfers()
  const old = transfer()
  const current = transfer()
  const finishOld = registry.start(source, old)
  const finishCurrent = registry.start(source, current)
  expect(finishOld()).toBe(false)
  expect(registry.take(current)).toBe(source)
  expect(finishOld()).toBe(false)
  expect(finishCurrent()).toBe(true)
  expect(finishCurrent()).toBe(false)
  const disposed = registry.start(source, current)
  expect(registry.end()).toBe(false)
  expect(registry.take(current)).toBeUndefined()
  expect(disposed()).toBe(false)
  expect(registry.end()).toBe(false)
})

/** Browser event wrappers share a data store, not DataTransfer object identity. */
function browserDrag() {
  const store = new Map<string, string>()
  const protectedRead = vi.fn(() => '')
  const wrapper = (mode: 'start' | 'drop' | 'end') => ({
    setData: (type: string, value: string) => { if (mode === 'start') store.set(type, value) },
    getData: mode === 'end' ? protectedRead : (type: string) => store.get(type) ?? '',
    get types() { return [...store.keys()] }, effectAllowed: 'none', dropEffect: 'none', setDragImage: vi.fn(),
  }) as unknown as DataTransfer
  return { start: wrapper('start'), drop: wrapper('drop'), end: wrapper('end'), protectedRead }
}

it('cleans search cancellation with a different protected dragEnd wrapper', () => {
  const h = searchDragFixture()
  const event = browserDrag()
  const view = render(<SearchResultItem {...h.props} referenceDrag={h.owner} />)
  const row = view.getByRole('treeitem')
  fireEvent.dragStart(row, { dataTransfer: event.start })
  fireEvent.dragEnd(row, { dataTransfer: event.end })
  expect(h.registry.take(event.drop)).toBeUndefined()
  expect(event.protectedRead).not.toHaveBeenCalled()
})

it('cancels session reorder after a composer consumes a different drop wrapper', () => {
  const h = searchDragFixture()
  const event = browserDrag()
  const drag = { active: true, marker: 'before' as const, start: vi.fn(), hover: vi.fn(), drop: vi.fn(), end: vi.fn(), cancel: vi.fn() }
  const view = render(<SessionNodeItem node={{ ...h.props.result, blank: false, updatedAt: 0, pinned: false }}
    currentId={undefined} now={0} onOpen={vi.fn()} onRenameRequest={vi.fn()} renderSlot={() => null}
    drag={drag} referenceDrag={h.owner} useSessionAccess={() => true} t={h.props.t} />)
  const row = view.getByRole('treeitem')
  fireEvent.dragStart(row, { dataTransfer: event.start })
  expect(h.registry.take(event.drop)).toBe(source)
  fireEvent.dragEnd(row, { dataTransfer: event.end })
  expect(drag.cancel).toHaveBeenCalledTimes(1)
  expect(drag.end).not.toHaveBeenCalled()
  expect(event.protectedRead).not.toHaveBeenCalled()
})
