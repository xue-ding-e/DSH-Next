import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAdditionalRoots } from '../src/additional-roots.ts'
import { workspaceRecord } from '../src/spec.ts'

let temporary: string | undefined
async function fixture() {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-additional-roots-')))
  const main = join(temporary, 'main')
  const source = join(temporary, '资料-é')
  await mkdir(main)
  await mkdir(source)
  return { main, source, base: temporary }
}
afterEach(async () => {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
})

describe('workspace additional root defaults', () => {
  it('reads old records as no additional roots without changing the main path', () => {
    const record = workspaceRecord.parse({ path: '/main', title: 'main', sessionIds: [], createdAt: 'then', updatedAt: 'then' })
    expect(record.additionalRoots).toEqual([])
    expect(record.path).toBe('/main')
  })
  it('rejects malformed durable selections at the record parser', () => {
    const record = { path: '/main', title: 'main', sessionIds: [], createdAt: 'then', updatedAt: 'then' }
    for (const root of [
      { path: '/extra', access: 'read' }, { path: '/extra' },
      { path: 'relative', access: 'reference' }, { path: '/extra\0', access: 'write' },
    ]) expect(workspaceRecord.safeParse({ ...record, additionalRoots: [root] }).success).toBe(false)
  })
  it('normalizes Unicode paths and duplicates without mutating caller data', async () => {
    const { main, source } = await fixture()
    const input = [{ path: source + '/', access: 'reference' as const }, { path: source, access: 'reference' as const }]
    const result = await normalizeAdditionalRoots(main, input)
    expect(result).toEqual([{ path: source, access: 'reference' }])
    expect(input[0]?.path).toBe(source + '/')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)
  })
  it('captures caller selections before the first filesystem await', async () => {
    const { main, source } = await fixture()
    const input: { path: string; access: 'reference' | 'write' }[] = [{ path: source, access: 'reference' }]
    const pending = normalizeAdditionalRoots(main, input)
    input[0]!.access = 'write'
    input.push({ path: main, access: 'reference' })
    expect(await pending).toEqual([{ path: source, access: 'reference' }])
  })
  it('allows clearing defaults when the primary directory has disappeared', async () => {
    const { main } = await fixture()
    await rm(main, { recursive: true })
    expect(await normalizeAdditionalRoots(main, [])).toEqual([])
  })
  it('resolves symlink selection to the displayed physical path', async () => {
    const { main, source, base } = await fixture()
    const alias = join(base, 'alias')
    await symlink(source, alias, 'junction')
    expect(await normalizeAdditionalRoots(main, [{ path: alias, access: 'write' }])).toEqual([{ path: source, access: 'write' }])
  })
  it('rejects relative, NUL, missing and file paths', async () => {
    const { main, base } = await fixture()
    const file = join(base, 'file')
    await writeFile(file, '')
    for (const path of ['relative', main + '\0', join(base, 'missing'), file]) {
      await expect(normalizeAdditionalRoots(main, [{ path, access: 'reference' }])).rejects.toThrow()
    }
  })
  it('rejects mixed access aliases and ancestor conflicts in either order', async () => {
    const { main, source } = await fixture()
    const child = join(source, 'child')
    await mkdir(child)
    for (const roots of [
      [{ path: source, access: 'reference' as const }, { path: source, access: 'write' as const }],
      [{ path: source, access: 'reference' as const }, { path: child, access: 'write' as const }],
      [{ path: child, access: 'write' as const }, { path: source, access: 'reference' as const }],
    ]) await expect(normalizeAdditionalRoots(main, roots)).rejects.toThrow(/conflict/)
  })
  it('rejects reference overlap with the main root but keeps sibling prefixes separate', async () => {
    const { main, base } = await fixture()
    const nested = join(main, 'nested')
    const sibling = main + '-other'
    await mkdir(nested)
    await mkdir(sibling)
    for (const path of [main, nested, base]) {
      await expect(normalizeAdditionalRoots(main, [{ path, access: 'reference' }])).rejects.toThrow(/conflict/)
    }
    expect(await normalizeAdditionalRoots(main, [{ path: sibling, access: 'reference' }])).toEqual([{ path: sibling, access: 'reference' }])
    expect(await normalizeAdditionalRoots(main, [{ path: main, access: 'write' }])).toEqual([])
  })
})
