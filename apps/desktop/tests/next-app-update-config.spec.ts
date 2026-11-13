import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureNextAppUpdateConfig,
  resolveNextAppUpdateFeed,
  verifyNextAppUpdateConfig,
} from '../scripts/next-app-update-config.mjs'

const roots: string[] = []
const publish = [{ provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next', releaseType: 'prerelease', channel: 'rc' }]
const CACHE = 'dsh-next-desktop-updater'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-next-update-config-'))
  roots.push(root)
  const resourcesDir = join(root, 'resources')
  await mkdir(resourcesDir, { recursive: true })
  return resourcesDir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Next packaged updater configuration', () => {
  it('resolves the GitHub feed the Next release publishes through', () => {
    expect(resolveNextAppUpdateFeed(publish))
      .toEqual({ provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next', releaseType: 'prerelease', channel: 'rc' })
    for (const value of [
      undefined,
      [],
      [{ provider: 'generic', url: 'https://example.com/', channel: 'rc' }],
      [{ provider: 'github', owner: 'deepseek-ai', repo: 'deepseek-harness', releaseType: 'release', channel: 'latest' }],
      [{ provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next', releaseType: 'prerelease' }],
    ]) {
      expect(() => resolveNextAppUpdateFeed(value)).toThrow(/Next update config/u)
    }
  })

  // A `--dir` build owns no updater, so electron-builder writes no feed and the installed
  // application reports that it has no packaged update source.
  it('writes the feed into a directory build electron-builder left without one', async () => {
    const resourcesDir = await fixture()
    await expect(ensureNextAppUpdateConfig(resourcesDir, publish, CACHE)).resolves.toBe('written')
    expect(load(await readFile(join(resourcesDir, 'app-update.yml'), 'utf8'))).toEqual({
      provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next', releaseType: 'prerelease', channel: 'rc',
      updaterCacheDirName: CACHE,
    })
    await expect(verifyNextAppUpdateConfig(resourcesDir, publish, CACHE)).resolves.toBeUndefined()
  })

  it('keeps the feed electron-builder wrote instead of overwriting it', async () => {
    const resourcesDir = await fixture()
    const path = join(resourcesDir, 'app-update.yml')
    const written = 'owner: xue-ding-e\nrepo: DSH-Next\nprovider: github\nreleaseType: prerelease\nchannel: rc\n'
      + `updaterCacheDirName: ${CACHE}\n`
    await writeFile(path, written)
    await expect(ensureNextAppUpdateConfig(resourcesDir, publish, CACHE)).resolves.toBe('present')
    expect(await readFile(path, 'utf8')).toBe(written)
  })

  it.each([
    ['a feed that targets another repository', publish.map(() => ({ provider: 'github', owner: 'deepseek-ai',
      repo: 'deepseek-harness', releaseType: 'prerelease', channel: 'rc' }))],
    ['a non-GitHub provider', [{ provider: 'generic', url: 'https://example.com/', channel: 'rc' }]],
  ] as const)('refuses to seal %s', async (_label, value) => {
    const resourcesDir = await fixture()
    await expect(ensureNextAppUpdateConfig(resourcesDir, value, CACHE)).rejects.toThrow(/Next update config/u)
    await expect(readFile(join(resourcesDir, 'app-update.yml'), 'utf8')).rejects.toThrow(/ENOENT/u)
  })

  it('rejects a sealed feed that keeps another channel or cache directory', async () => {
    const resourcesDir = await fixture()
    await writeFile(join(resourcesDir, 'app-update.yml'),
      'provider: github\nowner: xue-ding-e\nrepo: DSH-Next\nreleaseType: prerelease\nchannel: latest\n'
      + `updaterCacheDirName: ${CACHE}\n`)
    await expect(verifyNextAppUpdateConfig(resourcesDir, publish, CACHE)).rejects.toThrow(/channel latest; expected rc/u)
    await writeFile(join(resourcesDir, 'app-update.yml'),
      'provider: github\nowner: xue-ding-e\nrepo: DSH-Next\nreleaseType: prerelease\nchannel: rc\n'
      + 'updaterCacheDirName: another-updater\n')
    await expect(verifyNextAppUpdateConfig(resourcesDir, publish, CACHE)).rejects.toThrow(/another-updater/u)
  })

  it('rejects a missing or unparsable sealed feed', async () => {
    const resourcesDir = await fixture()
    await expect(verifyNextAppUpdateConfig(resourcesDir, publish, CACHE)).rejects.toThrow(/is missing/u)
    await writeFile(join(resourcesDir, 'app-update.yml'), 'provider: [\n')
    await expect(verifyNextAppUpdateConfig(resourcesDir, publish, CACHE)).rejects.toThrow(/cannot parse/u)
  })
})

it('seals the Next feed for every prerelease channel the version scheme produces', async () => {
  const resourcesDir = await fixture()
  for (const channel of ['rc', 'beta', 'latest']) {
    const value = [{ provider: 'github', owner: 'xue-ding-e', repo: 'DSH-Next', releaseType: 'prerelease', channel }]
    await writeFile(join(resourcesDir, 'app-update.yml'), 'provider: github\nowner: xue-ding-e\nrepo: DSH-Next\n'
      + `releaseType: prerelease\nchannel: ${channel}\nupdaterCacheDirName: ${CACHE}\n`)
    await expect(verifyNextAppUpdateConfig(resourcesDir, value, CACHE)).resolves.toBeUndefined()
  }
})
