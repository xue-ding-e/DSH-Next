/** Write the Next GitHub release feed into an application directory electron-builder left without one. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { NEXT_DESKTOP_IDENTITY } from '../src/next-distribution.ts'

const CONFIG_FILENAME = 'app-update.yml'
const EXPECTED_FIELDS = ['provider', 'owner', 'repo', 'channel', 'releaseType', 'updaterCacheDirName']

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop Next update config: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Resolve the GitHub provider and channel the Next distribution publishes through.
 *
 * electron-builder writes `app-update.yml` only for packaging targets that own an updater, so a
 * `--dir` build, and any installer assembled from that directory, omits it. The installed
 * application then reports that it has no packaged update source and refuses every check.
 * @param {unknown} publish Final electron-builder publish setting.
 * @returns {{ provider: 'github', owner: string, repo: string, channel: string, releaseType: string }} Feed fields owned by the release configuration.
 */
export function resolveNextAppUpdateFeed(publish) {
  if (!Array.isArray(publish) || publish.length !== 1) {
    throw new Error('desktop Next update config: publish must contain exactly one provider')
  }
  const provider = publish[0]
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    throw new Error('desktop Next update config: publish provider must be an object')
  }
  const [owner, repo] = NEXT_DESKTOP_IDENTITY.repository.split('/')
  if (provider.provider !== 'github' || provider.owner !== owner || provider.repo !== repo) {
    throw new Error(`desktop Next update config: publish provider must publish to ${NEXT_DESKTOP_IDENTITY.repository}`)
  }
  return { provider: 'github', owner, repo, channel: nonEmptyString(provider.channel, 'publish channel'),
    releaseType: nonEmptyString(provider.releaseType, 'publish release type') }
}

async function readConfig(resourcesDir) {
  const path = join(resourcesDir, CONFIG_FILENAME)
  try { return { path, contents: await readFile(path, 'utf8') } }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { path, contents: undefined }
    throw new Error(`desktop Next update config: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function assertMatches(resourcesDir, publish, updaterCacheDirName) {
  const { path, contents } = await readConfig(resourcesDir)
  if (contents === undefined) throw new Error(`desktop Next update config: ${path} is missing`)
  let parsed
  try { parsed = load(contents) }
  catch (error) {
    throw new Error(`desktop Next update config: cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`desktop Next update config: ${path} must contain an object`)
  }
  const expected = { ...resolveNextAppUpdateFeed(publish), updaterCacheDirName }
  for (const field of EXPECTED_FIELDS) {
    if (parsed[field] !== expected[field]) {
      throw new Error(`desktop Next update config: ${path} has ${field} ${String(parsed[field])}; expected ${expected[field]}`)
    }
  }
}

/**
 * Ensure an assembled Next application carries the GitHub release feed.
 *
 * electron-builder's own output is verified rather than rewritten, so the file cannot disagree
 * with the feed the same run published; only a target that produced no file receives one.
 * @param {string} resourcesDir Assembled application resources directory.
 * @param {unknown} publish Final electron-builder publish setting.
 * @param {string} updaterCacheDirName electron-builder application cache directory for this package.
 * @returns {Promise<'written' | 'present'>} Whether this call created the configuration.
 */
export async function ensureNextAppUpdateConfig(resourcesDir, publish, updaterCacheDirName) {
  const { path, contents } = await readConfig(resourcesDir)
  if (contents !== undefined) {
    await assertMatches(resourcesDir, publish, updaterCacheDirName)
    return 'present'
  }
  const feed = resolveNextAppUpdateFeed(publish)
  await writeFile(path, dump({ ...feed, updaterCacheDirName },
    { lineWidth: -1, noRefs: true }))
  return 'written'
}

/**
 * Verify that an assembled Next application carries the exact GitHub release feed.
 * @param {string} resourcesDir Assembled application resources directory.
 * @param {unknown} publish Final electron-builder publish setting.
 * @param {string} updaterCacheDirName electron-builder application cache directory for this package.
 * @returns {Promise<void>} Resolves when the packaged configuration matches the release destination.
 */
export async function verifyNextAppUpdateConfig(resourcesDir, publish, updaterCacheDirName) {
  await assertMatches(resourcesDir, publish, updaterCacheDirName)
}
