// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { SessionReferenceTransfers, SESSION_REFERENCE_DRAG, stageSessionReference } from '../src/client/session-drag.ts'
import { SessionReferenceDrop } from '../src/client/SessionReferenceDrop.tsx'

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
