// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { FILE_REFERENCE_DRAG, stageFileReference } from '../src/client/file-drag.ts'
import { ReferenceTransfers } from '../src/client/reference-transfers.ts'
import type { FileReferenceSource } from '../src/client/file-drag.ts'
import { SESSION_REFERENCE_DRAG } from '../src/client/session-drag.ts'
import { SessionReferenceDrop } from '../src/client/SessionReferenceDrop.tsx'

afterEach(cleanup)
const source: FileReferenceSource = { sessionId: SessionId('synthetic-source'), path: '/synthetic/notes.txt', kind: 'file' }
const candidate = { path: source.path, kind: source.kind }
const mention = formatFileMention(candidate, false)!
function transfer() {
  const data = new Map<string, string>()
  return { getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => { data.set(type, value) }, get types() { return [...data.keys()] }, dropEffect: 'none' } as unknown as DataTransfer
}
function shell() {
  const sink = vi.fn()
  const input = new SessionInputShell({ actx: new Context(), defaultSink: sink, commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  return { input, sink }
}

it('keeps file tokens separate from sessions and browser uploads, and consumes once', () => {
  const registry = new ReferenceTransfers<FileReferenceSource>(FILE_REFERENCE_DRAG)
  const item = transfer()
  item.setData(FILE_REFERENCE_DRAG, source.path)
  expect(registry.take(item)).toBeUndefined()
  registry.start(source, item)
  expect(item.types).not.toContain('Files')
  expect(item.types).not.toContain(SESSION_REFERENCE_DRAG)
  expect(registry.take(item)).toEqual(source)
  expect(registry.take(item)).toBeUndefined()
  registry.start(source, item)
  registry.end()
  expect(registry.take(item)).toBeUndefined()
})

it('stages multiple real file/directory editor chips, deduplicates, and never sends', async () => {
  const { input, sink } = shell()
  try {
    input.setDraft('Review ')
    expect(await stageFileReference(input, source, async () => candidate, new AbortController().signal)).toBe('inserted')
    expect(input.state.getSnapshot().occurrences).toMatchObject([{ source: 'reference', ref: mention }])
    expect(await stageFileReference(input, source, async () => candidate, new AbortController().signal)).toBe('duplicate')
    const directory = { ...source, path: '/synthetic/folder', kind: 'directory' as const }
    expect(await stageFileReference(input, directory, async () => directory, new AbortController().signal)).toBe('inserted')
    expect(input.state.getSnapshot().occurrences).toHaveLength(2)
    expect(sink).not.toHaveBeenCalled()
  } finally { input.dispose() }
})

it('keeps newer draft edits and cancels a pending file resolution without staging', async () => {
  const { input, sink } = shell()
  try {
    const gate = Promise.withResolvers<typeof candidate>()
    const pending = stageFileReference(input, source, () => gate.promise, new AbortController().signal)
    input.setDraft('newer draft')
    gate.resolve(candidate)
    expect(await pending).toBe('changed')
    expect(input.state.getSnapshot().draft).toBe('newer draft')
    const controller = new AbortController()
    const second = Promise.withResolvers<typeof candidate>()
    const cancelled = stageFileReference(input, source, () => second.promise, controller.signal)
    controller.abort()
    second.resolve(candidate)
    await expect(cancelled).rejects.toThrow()
    expect(input.state.getSnapshot().occurrences).toHaveLength(0)
    expect(sink).not.toHaveBeenCalled()
  } finally { input.dispose() }
})

it('routes only file-reference MIME to its own composer and aborts on unmount', () => {
  let signal: AbortSignal | undefined
  const drop = vi.fn(async (_item: DataTransfer, value: AbortSignal) => { signal = value })
  const view = render(<><div data-composer-card data-testid="own"><SessionReferenceDrop mime={FILE_REFERENCE_DRAG} drop={drop} /></div><div data-composer-card data-testid="other" /></>)
  const item = transfer()
  item.setData(SESSION_REFERENCE_DRAG, 'session-token')
  fireEvent.drop(view.getByTestId('own'), { dataTransfer: item })
  expect(drop).not.toHaveBeenCalled()
  item.setData(FILE_REFERENCE_DRAG, 'file-token')
  fireEvent.drop(view.getByTestId('other'), { dataTransfer: item })
  expect(drop).not.toHaveBeenCalled()
  fireEvent.drop(view.getByTestId('own'), { dataTransfer: item })
  expect(drop).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(signal?.aborted).toBe(true)
})
