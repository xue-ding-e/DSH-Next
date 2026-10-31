import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nextDesktopEnvironment, nextDesktopHome } from '../src/next-profile.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = join(process.env.TEMP ?? process.env.TMP ?? '.', `dsh-next-profile-${String(Date.now())}-${String(Math.random()).slice(2)}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

it('migrates the existing Harness data once while preserving the source', async () => {
  const home = await fixture()
  const upstream = join(home, '.dsh')
  await mkdir(join(upstream, 'sessions'), { recursive: true })
  await mkdir(join(upstream, 'cache'), { recursive: true })
  await writeFile(join(upstream, 'sessions', 'session.jsonl'), 'session\n')
  await writeFile(join(upstream, '.credentials.yaml'), 'credentials\n')
  await writeFile(join(upstream, 'cache', 'discard-me'), 'cache\n')

  const first = await nextDesktopEnvironment(home, {})
  const target = join(home, '.dsh-next')
  expect(first.DSH_HOME).toBe(target)
  await expect(readFile(join(target, 'sessions', 'session.jsonl'), 'utf8')).resolves.toBe('session\n')
  await expect(readFile(join(target, '.credentials.yaml'), 'utf8')).resolves.toBe('credentials\n')
  await expect(readFile(join(target, 'cache', 'discard-me'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

  await writeFile(join(target, 'sessions', 'new.jsonl'), 'new\n')
  await nextDesktopEnvironment(home, {})
  await expect(readFile(join(target, 'sessions', 'new.jsonl'), 'utf8')).resolves.toBe('new\n')
  await expect(readFile(join(upstream, 'sessions', 'session.jsonl'), 'utf8')).resolves.toBe('session\n')
})

it('does not copy data into an explicitly configured Next home', async () => {
  const home = await fixture()
  await mkdir(join(home, '.dsh', 'sessions'), { recursive: true })
  await writeFile(join(home, '.dsh', 'sessions', 'session.jsonl'), 'session\n')
  const configured = join(home, 'custom-next')
  const environment = await nextDesktopEnvironment(home, { DSH_NEXT_HOME: configured })
  expect(environment.DSH_HOME).toBe(configured)
  await expect(readFile(join(configured, 'sessions', 'session.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('continues to reject the upstream data root as the Next home', () => {
  expect(() => nextDesktopHome('C:\\Users\\user', 'C:\\Users\\user\\.dsh')).toThrow(/separate data directory/u)
})
