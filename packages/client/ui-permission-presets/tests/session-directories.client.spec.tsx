// @vitest-environment jsdom
/** DOM → generated Gateway codecs → exact Agent policy → real scratch file sandbox. */
import { useMemo } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ResourceRegistry } from '../../resources/src/client/resources.ts'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionRootsState } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DirectoryHostBridge, DirectoryHostFactory } from '../../../api/session-controller/tests/root-permissions-wire.ts'
import { DirectoryCommands, directoryAddress } from '../src/client/directories.ts'
import { SessionDirectories, type SessionDirectoriesProps } from '../src/client/SessionDirectories.tsx'
import { directoriesZh } from '../src/client/directories-locales.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { cleanup(); for (const dispose of cleanups.splice(0).reverse()) await dispose() })

async function setup(withWorkspace = false) {
  // Keep Host and Client ambient Cordis declarations in their own compiler faces.
  // The Host module is checked by its Host tests; this boundary carries only wire data and owned fixture probes.
  const hostModule = '../../../api/session-controller/tests/root-permissions-ui-bridge.ts'
  const hostExports = await import(hostModule) as { createDirectoryHost: DirectoryHostFactory }
  const host: DirectoryHostBridge = await hostExports.createDirectoryHost()
  cleanups.push(() => host.dispose())
  let pickedDirectory = host.reference
  let pickerOwner: DirectoryFlowOwnerProps | undefined
  const invocations: string[] = []
  const invoke = <T,>(method: string, request: unknown, signal?: AbortSignal): Promise<RemoteResult<T>> => {
    invocations.push(method)
    return host.invoke(method, request, signal) as Promise<RemoteResult<T>>
  }
  const commands = new DirectoryCommands({
    roots: (request, signal) => invoke('roots', request, signal),
    replaceRoots: (request, signal) => invoke('replaceRoots', request, signal),
    prepareRoots: (request, signal) => invoke('prepareRoots', request, signal),
    confirmRoots: (request, signal) => invoke('confirmRoots', request, signal),
    cancelRoots: (request, signal) => invoke('cancelRoots', request, signal),
  })
  cleanups.push(() => { commands.dispose() })
  const ui = new Context()
  cleanups.push(() => ui.fiber.dispose())
  const resources = new ResourceRegistry(ui)
  cleanups.push(resources.register(commands.provider))
  cleanups.push(host.changed((sessionId) => { commands.invalidate(sessionId) }))
  cleanups.push(host.lifecycle((sessionId) => { commands.replaceLifetime(sessionId) }))
  const running = createSnapshotStore(false)
  const initialWorkspace = withWorkspace ? await host.initializeWorkspace() : undefined
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({ phase: 'ready', state: 'idle', error: null,
    items: initialWorkspace === undefined ? [] : [initialWorkspace], archivedSessionIds: [], pinnedSessionIds: [] })
  const props = {
    sessionId: host.sessionId, address: directoryAddress(host.sessionId),
    useResource: (address: string) => {
      const useSnapshot = useMemo(() => bindSnapshotSelector(resources.source(address)), [address])
      return useSnapshot(value => value) as ResourceSnapshot<SessionRootsState>
    },
    useSession: (selector: (snapshot: { running: boolean }) => unknown) =>
      bindSnapshotSelector(running)(value => selector({ running: value })),
    useWorkspaceList: bindSnapshotSelector(workspaces),
    useDirectoryLifetime: bindSnapshotSelector(commands.lifetimeOf(host.sessionId)),
    useDirectoryConnection: bindSnapshotSelector(commands.connection), useDirectoryChange: bindSnapshotSelector(commands.changes),
    useDirectoryFlow: bindSnapshotSelector(createSnapshotStore(true)),
    replace: (roots, revision) => commands.replace(host.sessionId, roots, revision),
    saveDefaults: async (workspaceId, roots) => {
      const result = await host.invokeWorkspace({ workspaceId, roots })
      if (!result.ok) throw new Error(result.error.message)
      workspaces.set({ ...workspaces.getSnapshot(), items: [result.value] })
    },
    prepare: () => commands.prepare(host.sessionId), confirm: nonce => commands.confirm(host.sessionId, nonce),
    cancel: nonce => commands.cancel(host.sessionId, nonce), abort: () => { commands.abort(host.sessionId) },
    refresh: () => { commands.invalidate(host.sessionId) }, t: makeTranslate(directoriesZh),
    renderSlot: (_name, owner) => {
      const flow = owner as object as DirectoryFlowOwnerProps
      pickerOwner = flow
      return flow.open ? <button onClick={() => { flow.onPicked(pickedDirectory) }}>fixture choose directory</button> : null
    },
  } satisfies Pick<SessionDirectoriesProps, 'sessionId' | 'address' | 'useWorkspaceList' | 'useDirectoryConnection' | 'useDirectoryChange'
    | 'useDirectoryLifetime' | 'useDirectoryFlow' | 'replace' | 'saveDefaults' | 'prepare' | 'confirm' | 'cancel' | 'abort' | 'refresh' | 't' | 'renderSlot'>
    & { useResource: (address: string) => ResourceSnapshot<SessionRootsState>; useSession: unknown }
  render(<SessionDirectories {...props as SessionDirectoriesProps} />)
  fireEvent.click(screen.getByRole('button', { name: '管理目录' }))
  await screen.findByText(/主目录（保持不变）/)
  return { host, commands, running, invocations, workspaces, pickerOwner: () => pickerOwner,
    pickDirectory: (path: string) => { pickedDirectory = path } }
}

async function confirmPreview() {
  fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
  const preview = await screen.findByRole('region', { name: '预览确认' })
  fireEvent.click(within(preview).getByRole('checkbox'))
  fireEvent.click(within(preview).getByRole('button', { name: '确认所选目录' }))
  await waitFor(() => { expect(screen.queryByRole('region', { name: '预览确认' })).toBeNull() })
}

describe('directory permission UI with the real Host', () => {
  it('requires explicit confirmation, revokes after editing, and never writes reference paths', async () => {
    const { host } = await setup()
    await expect(host.probe('source')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await confirmPreview()
    await waitFor(async () => { await expect(host.probe('source')).resolves.toBeUndefined() })
    await expect(host.probe('reference')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(async () => { await expect(host.probe('source')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' }) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '预览确认' }).hasAttribute('disabled')).toBe(false) })
    await confirmPreview()
    await expect(host.probe('reference')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('cancels previews and clears authority across same-id reconstruction and reconnect', async () => {
    const { host, commands } = await setup()
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    const preview = await screen.findByRole('region', { name: '预览确认' })
    fireEvent.click(within(preview).getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.queryByRole('region', { name: '预览确认' })).toBeNull() })
    await expect(host.probe('source')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await confirmPreview()
    await act(async () => { await host.replaceSession(); commands.reset() })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '管理目录' }))
    await screen.findByText(/主目录（保持不变）/)
    await expect(host.probe('source')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('disables mutation while running and permits reference-only confirmation without write capability', async () => {
    const { host, commands, running } = await setup()
    await act(async () => { running.set(true) })
    expect(screen.getByRole('button', { name: '预览确认' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { running.set(false) })
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '预览确认' }).hasAttribute('disabled')).toBe(false) })
    await act(async () => { host.writeSupport(false); commands.invalidate(host.sessionId) })
    await screen.findByText(/当前后端或模式不支持附加写目录/)
    await confirmPreview()
    await expect(host.probe('reference')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('sends one confirmation for repeated clicks and removes active authority when the mode changes', async () => {
    const { host, invocations } = await setup()
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    const preview = await screen.findByRole('region', { name: '预览确认' })
    fireEvent.click(within(preview).getByRole('checkbox'))
    const button = within(preview).getByRole('button', { name: '确认所选目录' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(async () => { await expect(host.probe('source')).resolves.toBeUndefined() })
    expect(invocations.filter(method => method === 'confirmRoots')).toHaveLength(1)
    await act(async () => { host.mode('read-only') })
    await screen.findByText('当前模式: read-only')
    await expect(host.probe('source')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(screen.getByText(/^已确认写目录:/).textContent).toContain('没有附加目录')
  })

  it('shows a missing-directory error instead of offering confirmation or activating writes', async () => {
    const { host } = await setup()
    await host.removeSourceDirectory()
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('region', { name: '预览确认' })).toBeNull()
    expect(screen.getByText(/^已确认写目录:/).textContent).toContain('没有附加目录')
  })


  it('builds a multi-directory reference selection through the chooser without changing cwd or granting writes', async () => {
    const { host, pickDirectory } = await setup()
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    for (const path of [host.source, host.reference]) {
      pickDirectory(path)
      fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
      fireEvent.click(screen.getByRole('button', { name: 'fixture choose directory' }))
    }
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '预览确认' }).hasAttribute('disabled')).toBe(false) })
    await confirmPreview()
    const current = await host.invoke('roots', { sessionId: host.sessionId })
    expect(current).toMatchObject({ ok: true, value: { primaryPath: host.primary, confirmedRoots: [
      { path: host.source, access: 'reference' }, { path: host.reference, access: 'reference' },
    ], activeWritableRoots: [] } })
    await expect(host.probe('source')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(host.probe('reference')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })


  it('saves future-session defaults from the UI without revoking or changing the current selection', async () => {
    const { host, workspaces } = await setup(true)
    await confirmPreview()
    const before = await host.invoke('roots', { sessionId: host.sessionId })
    fireEvent.click(screen.getByRole('button', { name: '新会话默认目录' }))
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    fireEvent.click(screen.getByRole('button', { name: 'fixture choose directory' }))
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await waitFor(() => { expect(workspaces.getSnapshot().items[0]?.additionalRoots).toEqual([
      { path: host.reference, access: 'reference' },
    ]) })
    expect(await host.invoke('roots', { sessionId: host.sessionId })).toEqual(before)
    await expect(host.probe('source')).resolves.toBeUndefined()
    expect(workspaces.getSnapshot().items[0]?.path).toBe(host.primary)
  })


  it('refuses an old edited draft after a second owner updates the selection', async () => {
    const { host } = await setup()
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]!)
    const before = await host.invoke('roots', { sessionId: host.sessionId }) as RemoteResult<SessionRootsState>
    if (!before.ok) throw new Error(before.error.message)
    await act(async () => {
      expect(await host.invokeOther('replaceRoots', { sessionId: host.sessionId, roots: [], expectedRevision: before.value.rootsRevision }))
        .toMatchObject({ ok: true })
    })
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存选择' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: '保存选择' }))
    await screen.findByRole('alert')
    expect(await host.invoke('roots', { sessionId: host.sessionId })).toMatchObject({ ok: true, value: { roots: [] } })
  })

  it('clears edits and an old chooser on actual same-id lifecycle notifications without a connection reset', async () => {
    const { host, pickerOwner } = await setup()
    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    const oldPicker = pickerOwner()!
    await act(async () => { await host.replaceSession() })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '管理目录' }))
    await screen.findByText(/主目录（保持不变）/)
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    await act(async () => { oldPicker.onPicked(host.reference) })
    expect(screen.getAllByRole('button', { name: '移除' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: '保存选择' }).hasAttribute('disabled')).toBe(true)
  })

  it.each([false, true])('discards a pending chooser answer across tabs (starts in defaults: %s)', async (fromDefaults) => {
    const { host, pickerOwner } = await setup(true)
    if (fromDefaults) fireEvent.click(screen.getByRole('button', { name: '新会话默认目录' }))
    fireEvent.click(screen.getByRole('button', { name: '添加目录' }))
    const oldPicker = pickerOwner()!
    fireEvent.click(screen.getByRole('button', { name: fromDefaults ? '本会话' : '新会话默认目录' }))
    await act(async () => { oldPicker.onPicked(host.reference) })
    expect(screen.queryByRole('button', { name: 'fixture choose directory' })).toBeNull()
    expect(screen.queryAllByRole('button', { name: '移除' })).toHaveLength(fromDefaults ? 2 : 0)
    expect(screen.getByRole('button', { name: '保存选择' }).hasAttribute('disabled')).toBe(true)
  })

})
