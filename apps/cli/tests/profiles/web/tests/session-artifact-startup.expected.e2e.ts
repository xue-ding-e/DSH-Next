/** Exercise on-disk Session encoding through the shipped Web profile and its Remote API. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { logPath, toHeaderLine } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { meta, oneTurnLog } from '../../../../../../packages/session/session-persistence/tests/contract.ts'
import { webGet, webRequest, withDefaultWeb } from './default-web-process.ts'

const restoredId = 'restored-session'
const importedId = 'imported-session'

async function connect(url: string, signal: AbortSignal) {
  const auth = await webGet(url, signal)
  expect(auth.status).toBe(303)
  const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('The Web profile did not issue an authentication cookie')
  return async (method: string, args: Record<string, unknown>) => {
    const rpcId = randomUUID()
    const response = await webRequest(new URL(`/api/${method}`, url), signal, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    expect(response.status, response.text).toBe(200)
    const envelope = JSON.parse(response.text) as { result?: unknown }
    expect(envelope).toMatchObject({ type: 'server-response', rpcId })
    return envelope.result
  }
}

async function fixture(root: string, id: string) {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const header = { ...meta(id, cwd), createdAt: id === importedId ? 2000 : 1000 }
  const sessions = join(root, 'home', 'sessions')
  const compressed = logPath(sessions, cwd, header.id, 'zstd')
  const raw = logPath(sessions, cwd, header.id, 'none')
  const head = `${JSON.stringify(toHeaderLine(header))}\n`
  const events = oneTurnLog()
  const body = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
  await mkdir(dirname(compressed), { recursive: true })
  const framed = Buffer.concat([await compressZstdFrame(head), await compressZstdFrame(body)])
  return { compressed, raw, head, body, framed, events }
}

const history = (sessionId: string) => ({ request: { address: { kind: 'session', sessionId } } })

it('reports a duplicate plaintext artifact at startup without changing either file', async (test) => {
  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    const inventory = await rpc('pluginInventory/list', {}) as {
      ok: boolean
      value: { entries: { entryId: string; fiberPhase: string; diagnostic?: string }[] }
    }
    expect(inventory.ok).toBe(true)
    const entries = new Map(inventory.value.entries.map(entry => [entry.entryId, entry]))
    expect(entries.get('include:workspace')).toMatchObject({
      fiberPhase: 'failed', diagnostic: expect.stringContaining('configured for compression "zstd"'),
    })
    expect(entries.get('include:workspace-controller')?.fiberPhase).toBe('pending')
    expect(entries.get('include:session-controller')?.fiberPhase).toBe('pending')
    expect(await rpc('workspace/create', { request: { path: join(root, 'project') } })).toMatchObject({
      ok: false, error: { code: 'gateway/service-unavailable' },
    })
    const files = await fixture(root, restoredId)
    expect(await readFile(files.raw, 'utf8')).toBe(files.head + files.body)
    expect(await readFile(files.compressed)).toEqual(files.framed)
  }, { prepare: async (root) => {
    const files = await fixture(root, restoredId)
    await writeFile(files.raw, files.head + files.body)
    await writeFile(files.compressed, files.framed)
  } })
})

it.for([false, true])('restores history and folder creation with the duplicate outside storage (import reframed: %s)', async (reframed, test) => {
  await withDefaultWeb(test, async ({ root, url }) => {
    const rpc = await connect(url, test.signal)
    expect(await rpc('session/list', { _request: {} })).toMatchObject({
      ok: true, value: {
        items: reframed ? [{ sessionId: importedId }, { sessionId: restoredId }] : [{ sessionId: restoredId }],
      },
    })
    expect(await rpc('workspace/create', { request: { path: join(root, 'project') } })).toMatchObject({
      ok: true, value: {
        created: false, workspace: { title: 'project', sessionIds: reframed ? [importedId, restoredId] : [restoredId] },
      },
    })
    const files = await fixture(root, restoredId)
    expect(await rpc('session/page', history(restoredId))).toMatchObject({
      ok: true, value: { records: files.events.map(event => ({ type: 'event', event })) },
    })
    const imported = await fixture(root, importedId)
    const importedHistory = await rpc('session/page', history(importedId))
    if (reframed) {
      expect(importedHistory).toMatchObject({
        ok: true, value: { records: imported.events.map(event => ({ type: 'event', event })) },
      })
      expect(await readFile(join(root, 'import-backup.jsonl.zstd'))).toEqual(await compressZstdFrame(imported.head + imported.body))
    } else {
      expect(importedHistory).toMatchObject({
        ok: false, error: { message: expect.stringContaining('first frame is not exactly one header line') },
      })
    }
    const path = join(root, 'new-folder')
    await mkdir(path)
    expect(await rpc('workspace/create', { request: { path } })).toMatchObject({
      ok: true, value: { created: true, workspace: { title: 'new-folder' } },
    })
    expect(await readFile(join(root, 'plaintext-backup.jsonl'), 'utf8')).toBe(files.head + files.body)
    expect(await readFile(files.compressed)).toEqual(files.framed)
  }, { prepare: async (root) => {
    const restored = await fixture(root, restoredId)
    const imported = await fixture(root, importedId)
    await writeFile(restored.raw, restored.head + restored.body)
    await writeFile(restored.compressed, restored.framed)
    await rename(restored.raw, join(root, 'plaintext-backup.jsonl'))
    const singleFrame = await compressZstdFrame(imported.head + imported.body)
    await writeFile(imported.compressed, reframed ? imported.framed : singleFrame)
    if (reframed) await writeFile(join(root, 'import-backup.jsonl.zstd'), singleFrame)
  } })
})
