/** Synthetic folders through real root confirmation, Agent, Gateway and file discovery. */
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import LocalFileReferences from '@deepseek-ai/dsh-file-reference-local'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { RootApprovalPreview, SessionDirectoryState } from '@deepseek-ai/dsh-sandbox-policy/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import { writeFile, rename, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanupRootPermissionsFixture, rootPermissionsFixture } from './root-permissions-fixture.ts'
afterEach(cleanupRootPermissionsFixture)

async function fixture() {
  const h = await rootPermissionsFixture()
  await h.ctx.plugin(LocalFileReferences)
  await writeFile(join(h.primary, 'same.txt'), 'primary synthetic')
  await writeFile(join(h.reference, 'same.txt'), 'reference synthetic')
  await writeFile(join(h.source, 'same.txt'), 'write synthetic')
  const confirm = async (id = h.agent.id) => {
    const preview = await h.call('prepareRoots', { request: { sessionId: id } }) as RootApprovalPreview
    await h.call('confirmRoots', { request: { sessionId: id, nonce: preview.nonce } })
  }
  return { ...h, confirm, list: (query = '') => h.ctx.fileReferences.list(h.agent, query, new AbortController().signal) }
}

it('keeps pending directories hidden and disambiguates confirmed roots with absolute paths', async () => {
  const h = await fixture()
  expect(await h.list(join(h.reference, 'same.txt'))).toEqual([])
  await h.confirm()
  const paths = (await h.list()).map(candidate => candidate.path)
  expect(paths).toContain('same.txt')
  expect(paths).toContain(join(h.reference, 'same.txt').replaceAll('\\', '/'))
  expect(paths).toContain(join(h.source, 'same.txt').replaceAll('\\', '/'))
  setSandboxMode(h.agent.session, 'read-only')
  expect(await h.list(join(h.reference, 'same.txt'))).toEqual([])
})

it('resolves a confirmed nested file through the real Gateway without reading its content', async () => {
  const h = await fixture()
  await h.confirm()
  const target = (await h.ctx.agents.create({ sessionId: SessionId('file-root-positive'), meta: { cwd: h.primary } })).agent
  h.ctx.sandboxPolicy.initializeRequestedRoots(target.session, [{ path: h.reference, access: 'reference' }])
  await h.confirm(target.id)
  await mkdir(join(h.reference, 'sub'))
  const path = join(h.reference, 'sub', 'same.txt')
  await writeFile(path, 'synthetic metadata-only reference')
  await expect(h.ctx.typertGateway.invoke({ peer: h.peer, namespace: 'fileReferences', method: 'resolveDrop', args: {
    agentId: target.id, sourceSessionId: h.agent.id, path, kind: 'file',
  } })).resolves.toEqual({ path: path.replaceAll('\\', '/'), kind: 'file' })
})

it.each(['mode', 'target-mode', 'selection', 'same-id', 'disk-root', 'disk-subdir', 'symlink-subdir', 'disk-file', 'fs-provider', 'reconfirm'] as const)('rejects source %s replacement while the target lookup is pending', async (change) => {
  const h = await fixture()
  await h.confirm()
  const target = (await h.ctx.agents.create({ sessionId: SessionId('file-root-target'), meta: { cwd: h.primary } })).agent
  h.ctx.sandboxPolicy.initializeRequestedRoots(target.session, [{ path: h.reference, access: 'reference' }])
  await h.confirm(target.id)
  const nested = ['disk-subdir', 'symlink-subdir', 'disk-file'].includes(change)
  const path = nested ? join(h.reference, 'sub', 'same.txt') : join(h.reference, 'same.txt')
  if (nested) { await mkdir(join(h.reference, 'sub')); await writeFile(path, 'nested synthetic') }
  const actual = h.ctx.fileReferences.list.bind(h.ctx.fileReferences)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(h.ctx.fileReferences, 'list').mockImplementation(async (...args) => {
    const result = await actual(...args)
    if (args[0] === target) { entered.resolve(undefined); await release.promise }
    return result
  })
  const pending = h.ctx.typertGateway.invoke({ peer: h.peer, namespace: 'fileReferences', method: 'resolveDrop', args: {
    agentId: target.id, sourceSessionId: h.agent.id, path, kind: 'file',
  } })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'file-reference/unavailable' })
  try {
    await entered.promise
    if (change === 'mode') setSandboxMode(h.agent.session, 'read-only')
    if (change === 'target-mode') setSandboxMode(target.session, 'read-only')
    if (change === 'selection') {
      const state = await h.call('roots', { request: { sessionId: h.agent.id } }) as SessionDirectoryState
      await h.call('replaceRoots', { request: { sessionId: h.agent.id, expectedRevision: state.rootsRevision, roots: [] } })
    }
    if (change === 'same-id') {
      await h.handle.dispose()
      await h.ctx.agents.create({ sessionId: h.agent.id, meta: { cwd: h.primary }, seed: h.agent.session.snapshotEvents() })
    }
    if (change === 'fs-provider') {
      await h.fsFiber.dispose()
      await h.ctx.plugin(SandboxedFileSystem, { cwd: h.primary })
    }
    if (change === 'reconfirm') await h.confirm()
    if (change === 'disk-root') {
      await rename(h.reference, h.reference + '-old')
      await mkdir(h.reference)
      await writeFile(join(h.reference, 'same.txt'), 'replacement synthetic')
    }
    if (change === 'disk-subdir' || change === 'symlink-subdir') {
      await rename(join(h.reference, 'sub'), join(h.reference, 'sub-old'))
      if (change === 'symlink-subdir') await symlink(h.source, join(h.reference, 'sub'), 'dir')
      else { await mkdir(join(h.reference, 'sub')); await writeFile(path, 'replacement nested') }
    }
    if (change === 'disk-file') {
      await rename(path, path + '-old')
      await writeFile(path, 'replacement file')
    }
    release.resolve(undefined)
    await rejected
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending, rejected])
  }
})

it('allows confirmed reference-only selection without claiming additional write capability', async () => {
  const h = await fixture()
  const state = await h.call('roots', { request: { sessionId: h.agent.id } }) as SessionDirectoryState
  await h.call('replaceRoots', { request: { sessionId: h.agent.id, expectedRevision: state.rootsRevision,
    roots: [{ path: h.reference, access: 'reference' }] } })
  vi.spyOn(h.ctx.sandbox, 'supportsAdditionalWritableRoots').mockReturnValue(false)
  await h.confirm()
  expect(await h.list(join(h.reference, 'same.txt'))).toEqual([
    { path: join(h.reference, 'same.txt').replaceAll('\\', '/'), kind: 'file' },
  ])
  expect(await h.list(join(h.source, 'same.txt'))).toEqual([])
  expect(h.ctx.sandboxPolicy.resolve({ session: h.agent.session }).additionalWritableRoots).toBeUndefined()
})

it('does not silently downgrade an unsupported pending write request into reference authority', async () => {
  const h = await fixture()
  vi.spyOn(h.ctx.sandbox, 'supportsAdditionalWritableRoots').mockReturnValue(false)
  await expect(h.confirm()).rejects.toThrow()
  expect(await h.list(join(h.reference, 'same.txt'))).toEqual([])
  expect(await h.list(join(h.source, 'same.txt'))).toEqual([])
})
