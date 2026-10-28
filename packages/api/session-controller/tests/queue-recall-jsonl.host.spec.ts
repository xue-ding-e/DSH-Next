/** Real Loader/JSONL roundtrip of the production Inbox handoff, not a live AgentLoop writer test. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { recallAgent } from './queue-recall-agent.ts'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { queueRecallProjection } from '../src/queue-recall-projection.ts'
import type { SessionRequestId } from '../src/types.ts'

async function boot(root: string, contexts: Context[]): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-attachment-local'",
    '  config:',
    `    dshHome: ${JSON.stringify(join(root, 'home'))}`,
    '',
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
  ])
  // The table changes module resolution only; Loader owns activation and disposal.
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  expect(ctx.get('sessionPersistence')).toBeDefined()
  expect(ctx.get('attachments')).toBeInstanceOf(LocalAttachmentStore)
  return ctx
}

async function persist(ctx: Context, session: Session): Promise<void> {
  const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  try {
    await writer.append(session.snapshotEvents())
  } finally {
    // Canonical persistence fixture boundary: close drains pending JSONL writes and releases the lease.
    await writer.close()
  }
}

async function restore(ctx: Context, id: SessionId, expectedEvents: readonly SessionEvent[]): Promise<Session> {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    const stored = await reader.read()
    expect(stored.events).toEqual(expectedEvents)
    return Session.fromRestore(id, stored.events, reader.header, reader.inheritedEventCount, stored.eventState)
  } finally {
    await reader.close()
  }
}

it('recovers full queue recall identity and file bytes from JSONL in a fresh Loader without inheriting fork authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-queue-recall-jsonl-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    try {
      for (const ctx of contexts.toReversed()) await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const first = await boot(root, contexts)
  const { ctx: agentContext, session, inbox } = await recallAgent(Session.create(SessionId('persistent-recall-owner')))
  const bytes = Uint8Array.of(0, 255, 1, 128, 10, 13, 0)
  const file = await first.attachments.saveFile({ name: '中文 queue.bin', data: bytes })
  const message = createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'before\n界' },
    { type: 'file', attachment: file },
    { type: 'text', text: 'between' },
    // Image admission is not under test; this synthetic reference exercises lossless block persistence.
    { type: 'image', attachment: { attachmentId: AttachmentId('synthetic-image'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
    { type: 'text', text: 'after' },
  ] })
  const other = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'leave queued' }] })
  inbox.append('next-turn', message)
  inbox.append('next-turn', other)
  const requestId = brandString<SessionRequestId>('persistent-recall-request')
  const before = session.snapshotEvents().length
  expect(inbox.recall(message.id, requestId)).toBe(true)
  expect(session.snapshotEvents()).toHaveLength(before + 1)
  expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'agent/inbox/spliced', data: {
    target: 'next-turn', removedCount: 1, inserted: [], outcome: 'canceled', recall: { requestId, message },
  } })
  expect(inbox.nextTurn).toEqual([other])
  const fork = agentContext.sessions.fork(session, undefined, SessionId('persistent-recall-fork'))
  await persist(first, session)
  await persist(first, fork)
  const path = generationLogPath(join(root, 'sessions'), undefined, session.id, 4, 'none')
  const physicalBefore = await readFile(path)
  expect(physicalBefore.toString('utf8')).toContain('persistent-recall-request')
  await first.fiber.dispose()

  const second = await boot(root, contexts)
  expect(second).not.toBe(first)
  const resumeStarted = Date.now()
  const restored = await restore(second, session.id, session.snapshotEvents())
  const resumeFinished = Date.now()
  expect(restored).not.toBe(session)
  // A cold Session appends one ordinary resume marker; persisted events remain exact.
  expect(restored.snapshotEvents()).toEqual([...session.snapshotEvents(), {
    type: 'session/end-seed', data: {}, seq: session.snapshotEvents().length, time: expect.any(Number),
  }])
  expect(restored.snapshotEvents().at(-1)!.time).toBeGreaterThanOrEqual(resumeStarted)
  expect(restored.snapshotEvents().at(-1)!.time).toBeLessThanOrEqual(resumeFinished)
  const recalls = await second.sessionProjections.register(queueRecallProjection)
  expect(recalls.stateOf(restored).recalls).toEqual([{ requestId, message }])
  const replayed = await recallAgent(restored)
  expect(replayed.session.snapshotEvents()).toEqual(restored.snapshotEvents())
  const restoredInbox = replayed.inbox
  const eventCount = restored.snapshotEvents().length
  expect(restoredInbox.nextTurn).toEqual([other])
  expect(restoredInbox.recall(message.id, requestId)).toBe(false)
  expect(restored.snapshotEvents()).toHaveLength(eventCount)
  expect(replayed.session.snapshotEvents()).toHaveLength(eventCount)
  expect(restoredInbox.nextTurn).toEqual([other])
  const recoveredFile = recalls.stateOf(restored).recalls[0]?.message.content[1]
  if (recoveredFile?.type !== 'file') throw new Error('missing persisted file block')
  const chunks: Uint8Array[] = []
  for await (const chunk of second.attachments.readFileStream(recoveredFile.attachment)) chunks.push(chunk)
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
  expect(recoveredFile.attachment).toEqual(file)
  const restoredFork = await restore(second, fork.id, fork.snapshotEvents())
  expect(restoredFork.inheritedEventCount).toBe(fork.inheritedEventCount)
  expect(restoredFork.inheritedEventCount).toBeGreaterThan(0)
  expect(recalls.stateOf(restoredFork).recalls).toEqual([])
  expect(recalls.stateOf(second.sessions.create(SessionId('unrelated-owner'))).recalls).toEqual([])
  await second.fiber.dispose()
  expect(await readFile(path)).toEqual(physicalBefore)
})
