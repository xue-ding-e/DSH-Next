/**
 * Project an official Git range onto Next's linear history. Preparation and publication work
 * on Git objects. The only checkout of proposed code is in the read-only validation workflow.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const MAIN = 'refs/heads/main'
const MASTER = 'refs/heads/master'
const MIRROR = 'refs/heads/upstream-main'
const CURSOR = '.github/next-upstream-base'
const ACTIVE = '.github/workflows/'
const DISABLED = '.github/upstream-workflows/'
const LOCK = 'pnpm-lock.yaml'
const SHA = /^[a-f0-9]{40}$/
const EMPTY_SHA = '0'.repeat(40)
const ORIGIN = process.env.NEXT_SYNC_ORIGIN || 'origin'
const UPSTREAM = process.env.NEXT_SYNC_UPSTREAM || 'https://github.com/deepseek-ai/deepseek-harness.git'
const BOT_NAME = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const GITHUB_HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

class Blocked extends Error {}

function sha(value, label) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(label + ' must be a full lowercase Git SHA')
  return value
}

function git(args, { input, env, cwd, accept = [0] } = {}) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'merge.conflictStyle=diff3', ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (!accept.includes(result.status)) {
    throw new Error('git ' + args[0] + ' failed (' + (result.status ?? result.signal) + '): '
      + [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n'))
  }
  return result
}

function rev(spec) {
  return sha(git(['rev-parse', '--verify', spec]).stdout.trim(), spec)
}

function objectType(oid) {
  return git(['cat-file', '-t', oid], { accept: [0, 128] }).stdout.trim()
}

function blob(object, path) {
  return git(['cat-file', 'blob', path ? object + ':' + path : object]).stdout
}

function gitAuth(remote, token) {
  if (!token) return undefined
  const url = new URL(remote)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) {
    throw new Error('A sync token requires an HTTPS GitHub repository URL')
  }
  return {
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'http.' + url.href + '.extraheader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'http.followRedirects',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'push.followTags',
    GIT_CONFIG_VALUE_3: 'false',
  }
}

function remoteTip(remote, ref, env, { missing = false } = {}) {
  const result = git(['ls-remote', '--exit-code', '--refs', '--', remote, ref], { env, accept: [0, 2] })
  if (result.status === 2 && missing) return ''
  const [oid, actualRef] = result.stdout.trimEnd().split('\t')
  if (actualRef !== ref) throw new Error('Cannot read ' + ref + ' from ' + remote)
  return sha(oid, ref)
}

function fetchCommit(remote, oid, env) {
  if (!objectType(oid)) {
    git(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', remote, oid], { env })
  }
  if (objectType(oid) !== 'commit') throw new Error(oid + ' must be a Git commit')
  return oid
}

function isAncestor(before, after) {
  return git(['merge-base', '--is-ancestor', before, after], { accept: [0, 1] }).status === 0
}

function officialTarget(requested) {
  const tip = fetchCommit(UPSTREAM, remoteTip(UPSTREAM, MASTER))
  if (!requested || requested === tip) return tip
  const target = fetchCommit(UPSTREAM, sha(requested, 'Official target'))
  if (!isAncestor(target, tip)) throw new Error('Target ' + target + ' is outside official master ' + tip)
  return target
}

function readCursor(tree) {
  const value = blob(tree, CURSOR)
  if (value.length !== 41 || value[40] !== '\n') {
    throw new Error(CURSOR + ' must contain one full lowercase SHA followed by a newline')
  }
  return sha(value.slice(0, 40), CURSOR)
}

function treeEntries(tree, ...paths) {
  return new Map(git(['ls-tree', '-rz', '--full-tree', tree, '--', ...paths]).stdout.split('\0')
    .filter(Boolean).map(record => {
      const tab = record.indexOf('\t')
      const [mode, , oid] = record.slice(0, tab).split(' ')
      return [record.slice(tab + 1), { mode, oid }]
    }))
}

function indexLine(path, entry) {
  return (entry ? entry.mode + ' ' + entry.oid : '0 ' + EMPTY_SHA)
    + (entry?.stage ? ' ' + entry.stage : '') + '\t' + path + '\0'
}

function editTree(tree, edits) {
  if (edits.size === 0) return rev(tree + '^{tree}')
  const directory = mkdtempSync(join(tmpdir(), 'dsh-next-sync-index-'))
  const env = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    git(['read-tree', tree], { env })
    // Remove existing names first so file/directory replacements can insert all new entries.
    const lines = [...edits.keys()].map(path => indexLine(path, null))
    for (const [path, entry] of edits) if (entry) lines.push(indexLine(path, entry))
    git(['update-index', '-z', '--index-info'], { env, input: lines.join('') })
    return sha(git(['write-tree'], { env }).stdout.trim(), 'Edited tree')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function writeBlob(content) {
  return { mode: '100644', oid: sha(git(['hash-object', '-w', '--stdin'], { input: content }).stdout.trim(), 'Blob') }
}

function changedPaths(before, after, ...paths) {
  return git(['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-only', '-z', before, after, '--', ...paths])
    .stdout.split('\0').filter(Boolean)
}

function nextTrustPath(path) {
  return path === CURSOR
    || /^\.github\/(?:workflows|validation|actions)\/next-/i.test(path)
    || /^scripts\/next-upstream-sync(?:[./-]|$)/i.test(path)
    || /^apps\/desktop\/scripts\/next-github-release\.ps1$/i.test(path)
}

function repositoryGuards(entry) {
  if (!entry || !['100644', '100755'].includes(entry.mode)) return ''
  const lines = blob(entry.oid).split(/\r?\n/)
  const guards = []
  let job = ''
  for (let index = 0; index < lines.length; index++) {
    if (/^\S/.test(lines[index])) job = ''
    const jobKey = /^ {2}([\w-]+):\s*(?:#.*)?$/.exec(lines[index])
    if (jobKey) job = jobKey[1]
    const condition = /^(\s*)(?:-\s+)?if\s*:\s*(.*)/.exec(lines[index])
    if (!condition) continue
    const [ , indent, first ] = condition
    const fragments = [first]
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next].trim()
      if (!line || line.startsWith('#')) continue
      if (lines[next].search(/\S/) <= indent.length) break
      fragments.push(line)
    }
    const expression = fragments.join(' ')
    if (/\b(?:repository(?:_owner|_id|_owner_id)?|full_name)\b/i.test(expression)) guards.push(job + ': ' + expression)
  }
  return guards.join('\n')
}

function sameEntry(left, right) {
  return left?.oid === right?.oid && left?.mode === right?.mode
}

function projectedWorkflowEntries(tree, reasons) {
  const entries = treeEntries(tree, ACTIVE, DISABLED)
  const projected = new Map()
  const edits = new Map()
  for (const [path, entry] of entries) {
    if (path.startsWith(ACTIVE)) edits.set(path, null)
    if (path.startsWith(DISABLED) && !path.endsWith('.disabled')) continue
    const shadow = path.startsWith(ACTIVE) ? DISABLED + path.slice(ACTIVE.length) + '.disabled' : path
    const old = projected.get(shadow.toLowerCase())
    if (old && (old.shadow !== shadow || !sameEntry(old.entry, entry))) {
      reasons.push('Official workflow paths collide at ' + shadow)
    }
    projected.set(shadow.toLowerCase(), { path, shadow, entry })
  }
  return { projected, edits }
}

function projectOfficialWorkflows(head, base, target, reasons) {
  const old = projectedWorkflowEntries(base, reasons)
  const next = projectedWorkflowEntries(target, reasons)
  const community = new Map([...treeEntries(head, ACTIVE, DISABLED)]
    .map(([path, entry]) => [path.toLowerCase(), { path, entry }]))
  for (const key of new Set([...old.projected.keys(), ...next.projected.keys()])) {
    const before = old.projected.get(key)
    const after = next.projected.get(key)
    const shadow = after?.shadow ?? before.shadow
    const active = ACTIVE + shadow.slice(DISABLED.length, -'.disabled'.length)
    const installed = community.get(active.toLowerCase())
    const archived = community.get(key)
    if (installed && !sameEntry(before?.entry, after?.entry)) {
      if (!before) reasons.push('New official workflow shares active community path ' + installed.path)
      if (repositoryGuards(before?.entry) !== repositoryGuards(after?.entry)) {
        reasons.push('Official repository guard changed for ' + installed.path)
      }
    }
    if (before && (!installed || archived)) old.edits.set(before.shadow, before.entry)
    // A guarded community workflow can acquire a disabled upstream counterpart on its first update.
    if (after && (!installed || archived || !sameEntry(before?.entry, after.entry))) {
      next.edits.set(after.shadow, after.entry)
    }
  }
  return [editTree(base, old.edits), editTree(target, next.edits)]
}

function mergeTrees(head, baseTree, targetTree) {
  const merge = git(['merge-tree', '--write-tree', '--no-messages', '-z', '--merge-base=' + baseTree, head, targetTree],
    { accept: [0, 1] })
  const [tree, ...records] = merge.stdout.split('\0')
  const conflicts = records.filter(Boolean).map(record => {
    const tab = record.indexOf('\t')
    const [mode, oid, stage] = record.slice(0, tab).split(' ')
    return { path: record.slice(tab + 1), mode, oid: sha(oid, 'Conflict object'), stage: Number(stage) }
  })
  return { tree: sha(tree, 'Merge tree'), conflicts, conflicted: merge.status === 1 }
}

function manifestVersion(tree, path) {
  let manifest
  try {
    manifest = JSON.parse(blob(tree, path))
  } catch (error) {
    throw new Blocked('Cannot read manifest ' + path + ' as JSON', { cause: error })
  }
  if (typeof manifest?.version !== 'string' || !manifest.version) {
    throw new Blocked(path + ' must declare a version')
  }
  return manifest
}

function importerPaths(tree) {
  let text
  try {
    text = blob(tree, LOCK)
  } catch (error) {
    throw new Blocked('Cannot read ' + LOCK + ' from the integration tree', { cause: error })
  }
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf('importers:')
  const keys = new Set()
  for (let index = start + 1; start !== -1 && index < lines.length; index++) {
    const line = lines[index]
    if (/^\S/.test(line)) break
    if (!/^  \S/.test(line)) continue
    const entry = /^  (\S.*?):(?: \{\})?$/.exec(line)
    if (!entry) throw new Blocked('Cannot read importer key in ' + LOCK + ': ' + line)
    const key = entry[1]
    if (key.startsWith("'") && key.endsWith("'")) keys.add(key.slice(1, -1).replaceAll("''", "'"))
    else if (key.startsWith('"')) keys.add(JSON.parse(key))
    else keys.add(key)
  }
  if (!keys.has('.')) throw new Blocked(LOCK + ' is missing the root importer')
  return keys
}

function normalizeReleaseManifests(tree, target, edits) {
  const { version } = manifestVersion(tree, 'package.json')
  const official = treeEntries(target, 'packages', 'apps')
  // The depth here matches releasedManifests in scripts/verify-version-sync.ts.
  for (const [path, entry] of treeEntries(tree, 'packages', 'apps')) {
    if (!/^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+)\/package\.json$/.test(path)) continue
    const manifest = manifestVersion(tree, path)
    if (manifest.version === version) continue
    if (official.has(path)) throw new Blocked(path + ' has ' + manifest.version + ' but the root version is ' + version)
    const update = writeBlob(JSON.stringify({ ...manifest, version }, null, 2) + '\n')
    edits.set(path, { ...update, mode: entry.mode })
  }
}

function requireCommunityImporters(head, base, tree) {
  const before = importerPaths(base)
  const merged = importerPaths(tree)
  const missing = [...importerPaths(head)].filter(path => !before.has(path) && !merged.has(path))
  if (missing.length) throw new Blocked(LOCK + ' lost community importers: ' + missing.join(', '))
}

function plan(head, base, target) {
  const reasons = changedPaths(base, target).filter(nextTrustPath).map(path => 'Upstream changed a Next trust path: ' + path)
  const [baseTree, targetTree] = projectOfficialWorkflows(head, base, target, reasons)
  const merged = mergeTrees(head, baseTree, targetTree)
  const edits = new Map([[CURSOR, writeBlob(target + '\n')]])
  if (merged.conflicted) {
    const count = new Set(merged.conflicts.map(entry => entry.path)).size
    reasons.push(count ? 'Git reported conflicts in ' + count + ' paths' : 'Git reported a merge conflict without file stages')
  } else {
    try {
      normalizeReleaseManifests(merged.tree, target, edits)
      requireCommunityImporters(head, base, merged.tree)
    } catch (error) {
      if (!(error instanceof Blocked)) throw error
      reasons.push(error.message)
    }
  }
  const tree = editTree(merged.tree, edits)
  for (const path of changedPaths(head, tree)) {
    if (path.toLowerCase().startsWith(ACTIVE) || (nextTrustPath(path) && path !== CURSOR)) {
      reasons.push('Candidate changed a community trust path: ' + path)
    }
  }
  return { tree, conflicts: merged.conflicts, reasons }
}

function commitTree(tree, head, base, target) {
  const timestamp = git(['show', '-s', '--format=%ct', target]).stdout.trim()
  const date = timestamp + ' +0000'
  const env = {
    GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL, GIT_COMMITTER_DATE: date,
  }
  const message = 'chore(sync): integrate upstream ' + target.slice(0, 12)
    + '\n\nNext-Upstream-Base: ' + base + '\nNext-Upstream-Target: ' + target + '\n'
  return sha(git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', head], { env, input: message })
    .stdout.trim(), 'Candidate')
}

function bundleCandidate(path, candidate, head) {
  const ref = 'refs/next-sync/bundles/' + randomUUID()
  git(['update-ref', ref, candidate, EMPTY_SHA])
  try {
    git(['bundle', 'create', path, ref, '^' + head])
  } finally {
    git(['update-ref', '-d', ref, candidate])
  }
}

function unbundle(path) {
  git(['bundle', 'unbundle', resolve(path)])
}

function inspectCommit(candidate, head, target) {
  const headers = git(['cat-file', 'commit', candidate]).stdout.split('\n\n', 1)[0].split('\n')
  const parents = headers.filter(line => line.startsWith('parent '))
  if (parents.length !== 1 || parents[0] !== 'parent ' + head) {
    throw new Error('Candidate must have exactly one parent at ' + head)
  }
  if (readCursor(candidate) !== target) throw new Error('Candidate does not record official target ' + target)
  return rev(candidate + '^{tree}')
}

function output(fields, { summarize = false } = {}) {
  const text = Object.entries(fields).filter(([, value]) => typeof value === 'string')
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, text.map(([key, value]) => key + '=' + value + '\n').join(''))
  }
  if (summarize && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Next upstream sync\n\n'
      + text.map(([key, value]) => '- ' + key + ' `' + value + '`\n').join('') + '\n')
  }
  console.log(JSON.stringify(fields))
}

function prepare(options) {
  const destination = resolve(required(options, 'out'))
  mkdirSync(destination)
  const originAuth = gitAuth(ORIGIN, process.env.NEXT_SYNC_TOKEN)
  const head = fetchCommit(ORIGIN, options.head ? sha(options.head, 'Community parent') : remoteTip(ORIGIN, MAIN, originAuth),
    originAuth)
  const target = officialTarget(options.target)
  const base = fetchCommit(UPSTREAM, readCursor(head))
  const report = { head, base, target, status: 'current', reasons: [], conflicts: [] }
  if (base !== target) {
    if (isAncestor(target, base)) {
      report.status = 'stale'
    } else if (!isAncestor(base, target)) {
      report.status = 'blocked'
      report.reasons.push('Official target does not descend from the stored base')
    } else {
      Object.assign(report, plan(head, base, target))
      report.status = report.reasons.length ? 'blocked' : 'ready'
      report.candidate = commitTree(report.tree, head, base, target)
      bundleCandidate(join(destination, 'candidate.bundle'), report.candidate, head)
    }
  }
  writeFileSync(join(destination, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  output({ status: report.status, head, base, target, candidate: report.candidate, tree: report.tree }, { summarize: true })
}

function pushWithLease(remote, ref, head, candidate, env, { dryRun = false } = {}) {
  // The explicit lease is a compare-and-swap. The ancestry check limits it to fast-forward updates.
  if (head && !isAncestor(head, candidate)) throw new Error('Ref update is not a fast-forward for ' + ref)
  try {
    const result = git(['-c', 'push.followTags=false', 'push', '--no-verify', '--porcelain', ...(dryRun ? ['--dry-run'] : []),
      '--force-with-lease=' + ref + ':' + head, '--', remote, candidate + ':' + ref], { env })
    return { status: result.stdout.split(/\r?\n/).some(line => line.startsWith('=\t')) ? 'already' : 'pushed',
      actual: candidate }
  } catch (error) {
    let actual
    try {
      actual = remoteTip(remote, ref, env, { missing: true })
    } catch (readError) {
      throw new Error('Could not confirm the remote state after the push to ' + ref
        + ': ' + error.message + '\nReadback: ' + readError.message, { cause: readError })
    }
    if (!dryRun && actual === candidate) return { status: 'already', actual }
    if (actual !== head) return { status: 'raced', actual }
    throw error
  }
}

function publish(options) {
  const head = sha(options.head, 'Verified parent')
  const target = officialTarget(sha(options.target, 'Verified official target'))
  const candidate = sha(options.candidate, 'Verified candidate')
  const env = gitAuth(ORIGIN, process.env.NEXT_SYNC_TOKEN)
  fetchCommit(ORIGIN, head, env)
  const base = fetchCommit(UPSTREAM, readCursor(head))
  if (base === target || !isAncestor(base, target)) throw new Error('Candidate requires a new descendant of the stored base')
  const expected = plan(head, base, target)
  if (expected.reasons.length) throw new Error(expected.reasons.join('\n'))
  unbundle(required(options, 'bundle'))
  if (inspectCommit(candidate, head, target) !== expected.tree
    || commitTree(expected.tree, head, base, target) !== candidate) {
    throw new Error('Candidate differs from the independently recomputed integration tree or commit')
  }
  const result = pushWithLease(ORIGIN, MAIN, head, candidate, env)
  output({ ...result, candidate }, { summarize: true })
}

function checkout(options) {
  const head = sha(options.head, 'Validation parent')
  const candidate = sha(options.candidate, 'Validation candidate')
  const target = sha(options.target, 'Validation official target')
  if (rev('HEAD') !== head) throw new Error('Validation checkout does not match the prepared parent')
  unbundle(required(options, 'bundle'))
  inspectCommit(candidate, head, target)
  git(['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    'checkout', '--detach', candidate])
  if (rev('HEAD') !== candidate) throw new Error('Validation checkout does not match the prepared candidate')
}

function readReport(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  sha(report.head, 'Report parent')
  sha(report.base, 'Report official base')
  sha(report.target, 'Report official target')
  return report
}

function resolveWorktree(options) {
  const report = readReport(required(options, 'report'))
  const worktree = resolve(required(options, 'worktree'))
  if (existsSync(worktree)) throw new Error('Recovery worktree already exists: ' + worktree)
  const candidate = sha(report.candidate, 'Recovery candidate')
  const env = gitAuth(ORIGIN, process.env.NEXT_SYNC_TOKEN)
  fetchCommit(ORIGIN, report.head, env)
  fetchCommit(UPSTREAM, report.base)
  fetchCommit(UPSTREAM, report.target)
  unbundle(required(options, 'bundle'))
  if (inspectCommit(candidate, report.head, report.target) !== report.tree || readCursor(report.head) !== report.base) {
    throw new Error('Recovery bundle does not match the report')
  }
  git(['worktree', 'add', '--detach', '--no-checkout', worktree, report.head])
  git(['read-tree', '--reset', '-u', candidate], { cwd: worktree })
  const paths = new Set(report.conflicts.map(entry => entry.path))
  const lines = [...paths].map(path => indexLine(path, null))
  for (const entry of report.conflicts) lines.push(indexLine(entry.path, entry))
  if (lines.length) git(['update-index', '-z', '--index-info'], { cwd: worktree, input: lines.join('') })
  output({ worktree, head: report.head, target: report.target })
}

function finish(options) {
  const report = readReport(required(options, 'report'))
  if (rev('HEAD') !== report.head || readCursor(report.head) !== report.base) {
    throw new Error('Recovery result must be staged on the parent in the report')
  }
  const target = officialTarget(report.target)
  if (!isAncestor(report.base, target) || report.base === target) throw new Error('Recovery target must advance the official base')
  const staged = rev(git(['write-tree']).stdout.trim())
  requireCommunityImporters(report.head, report.base, staged)
  const edits = new Map([[CURSOR, writeBlob(target + '\n')]])
  normalizeReleaseManifests(staged, target, edits)
  const tree = editTree(staged, edits)
  output({ head: report.head, target, candidate: commitTree(tree, report.head, report.base, target), tree })
}

function required(options, key) {
  if (!options[key]) throw new Error('--' + key + ' is required')
  return options[key]
}

function repository(value) {
  if (typeof value !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value)) {
    throw new Error('Expected a GitHub repository in owner/name form')
  }
  return value
}

function apiClient(token) {
  const repo = repository(process.env.GITHUB_REPOSITORY)
  if (!token) throw new Error('The GitHub API requires NEXT_SYNC_TOKEN')
  return async (path, data) => {
    const response = await fetch('https://api.github.com/repos/' + repo + path, {
      method: data ? 'POST' : 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
      body: data ? JSON.stringify(data) : undefined,
    })
    if (!response.ok) throw new Error('GitHub API ' + path + ' returned HTTP ' + response.status)
    return response.status === 204 ? undefined : response.json()
  }
}

function workflowMapping(lines, indent) {
  const fields = new Map()
  let field
  for (const line of lines) {
    if (/^[ ]*(?:#.*)?$/.test(line)) continue
    const depth = /^ */.exec(line)[0].length
    if (depth > indent && field) {
      field.lines.push(line)
      continue
    }
    const match = /^(?:"([\w-]+)"|'([\w-]+)'|([\w-]+)):[ ]*(.*)$/.exec(line.slice(indent))
    if (depth !== indent || !match) throw new Blocked('Unsupported workflow event syntax')
    const key = match[1] ?? match[2] ?? match[3]
    if (fields.has(key)) throw new Blocked('Duplicate workflow field ' + key)
    field = { value: match[4].replace(/(?:^| +)#.*$/, '').trimEnd(), lines: [] }
    fields.set(key, field)
  }
  return fields
}

function workflowList(field) {
  const items = field.value.match(/^\[(.*)\]$/)
  if (items && !field.lines.length) return items[1].split(',').map(item => item.trim())
  if (!field.value && field.lines.length) {
    const prefix = /^ +- +/.exec(field.lines[0])?.[0]
    if (prefix && field.lines.every(line => line.startsWith(prefix))) {
      return field.lines.map(line => line.slice(prefix.length).replace(/ +#.*$/, '').trim())
    }
  }
  throw new Blocked('Unsupported workflow list syntax')
}

function simpleScalar(value) {
  const quoted = /^(["'])([^"'\\]+)\1$/.exec(value)
  return quoted?.[2] ?? value
}

function excludesMirrorBranch(pattern) {
  const name = simpleScalar(pattern)
  if (/^[A-Za-z0-9_.\/-]+$/.test(name)) return name !== MIRROR.slice('refs/heads/'.length)
  // The first slash in this subset is required. A one-component ref cannot match the pattern.
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*-][A-Za-z0-9_.\/?*+\[\]-]*$/.test(name)) return true
  throw new Blocked('Cannot verify workflow branch pattern ' + pattern)
}

function requireSafeMirrorTrigger(source, creating) {
  if (/[\t\r\u0085\u2028\u2029]/u.test(source.replaceAll('\r\n', '\n'))) {
    throw new Blocked('Unsupported whitespace in workflow syntax')
  }
  const trigger = workflowMapping(source.split(/\r?\n/), 0).get('on')
  if (!trigger) throw new Blocked('Cannot verify the workflow on field')
  let events
  if (!trigger.value && trigger.lines.length) {
    const indent = /^ */.exec(trigger.lines[0])[0].length
    if (trigger.lines[0].trimStart().startsWith('- ')) {
      events = new Map(workflowList(trigger).map(event => [simpleScalar(event), { value: '', lines: [] }]))
    } else {
      events = workflowMapping(trigger.lines, indent)
    }
  } else {
    const names = trigger.value.startsWith('[') ? workflowList(trigger) : [trigger.value]
    if (trigger.lines.length || !names.every(event => /^[a-z_]+$/.test(simpleScalar(event)))) {
      throw new Blocked('Unsupported workflow event syntax')
    }
    events = new Map(names.map(event => [simpleScalar(event), { value: '', lines: [] }]))
  }
  if ([...events.keys()].some(event => !/^[a-z_]+$/.test(event))) {
    throw new Blocked('Unsupported workflow event name')
  }
  if (creating && events.has('create')) throw new Blocked('Workflow can run when upstream-main is created')
  const push = events.get('push')
  if (!push) return
  if (!push.value && push.lines.length) {
    const indent = /^ */.exec(push.lines[0])[0].length
    const filters = workflowMapping(push.lines, indent)
    if (filters.has('branches') && !filters.has('branches-ignore')
      && workflowList(filters.get('branches')).every(excludesMirrorBranch)) return
    if (filters.has('branches-ignore') && !filters.has('branches')) {
      const ignored = workflowList(filters.get('branches-ignore')).map(simpleScalar)
      if (ignored.every(branch => /^[A-Za-z0-9_.\/-]+$/.test(branch)) && ignored.includes('upstream-main')) return
    }
    if (!filters.has('branches') && !filters.has('branches-ignore')
      && (filters.has('tags') || filters.has('tags-ignore'))) return
  }
  throw new Blocked('Cannot exclude upstream-main from the workflow push trigger')
}

function mirrorTriggerReasons(candidate, creating) {
  const reasons = []
  for (const [path, entry] of treeEntries(candidate, ACTIVE)) {
    if (!/^[^/]+\.ya?ml$/i.test(path.slice(ACTIVE.length))) continue
    try {
      if (!['100644', '100755'].includes(entry.mode)) throw new Blocked('Workflow must be a regular file')
      requireSafeMirrorTrigger(blob(entry.oid), creating)
    } catch (error) {
      if (!(error instanceof Blocked)) throw error
      reasons.push(path + ': ' + error.message)
    }
  }
  return reasons
}

function mirrorAudit(options) {
  const target = fetchCommit(UPSTREAM, sha(options.target, 'Mirror target'))
  const reasons = mirrorTriggerReasons(target, options.creating)
  output({ target, reasons })
  if (reasons.length) process.exitCode = 1
}

async function requirePassiveMirror(candidate, previous, token) {
  const reasons = mirrorTriggerReasons(candidate, !previous)
  if (reasons.length) throw new Blocked(reasons.join('\n'))
  const api = apiClient(token)
  const repo = await api('')
  if (repo.default_branch !== 'main') throw new Blocked('The official mirror requires main as the default branch')
  const owner = repository(process.env.GITHUB_REPOSITORY).split('/')[0]
  const [headPulls, basePulls] = await Promise.all([
    api('/pulls?state=open&per_page=1&head=' + encodeURIComponent(owner + ':upstream-main')),
    api('/pulls?state=open&per_page=1&base=upstream-main'),
  ])
  if (headPulls.length || basePulls.length) throw new Blocked('Close open pull requests using upstream-main before an SSH mirror push')
}

function mirrorReport(target, previous) {
  return { kind: 'mirror', head: previous || EMPTY_SHA, base: previous || EMPTY_SHA, target,
    status: 'blocked', reasons: [], conflicts: [] }
}

function saveMirrorReport(options, report, previous) {
  if (report.status === 'raced') report.reasons.push('Mirror moved while pinning or publishing this target')
  if (options.out) {
    const directory = resolve(options.out)
    mkdirSync(directory)
    writeFileSync(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  output({ status: report.status, previous, target: report.target, actual: report.actual, reasons: report.reasons },
    { summarize: true })
}

function requireRemoteMirrorTip(report, remote, env, expected) {
  report.actual = remoteTip(remote, MIRROR, env, { missing: true })
  if (report.actual !== expected) report.status = 'raced'
}

async function mirror(options) {
  const token = process.env.NEXT_SYNC_TOKEN
  if (!token && !isAbsolute(ORIGIN)) {
    throw new Error('Use the mirror workflow for a GitHub origin so its built-in token suppresses push events')
  }
  const env = gitAuth(ORIGIN, token)
  const target = officialTarget(options.target)
  const previous = remoteTip(ORIGIN, MIRROR, env, { missing: true })
  const report = mirrorReport(target, previous)
  try {
    if (options['verify-key']) {
      report.status = 'needs-ssh'
    } else {
      if (previous) fetchCommit(ORIGIN, previous, env)
      try {
        Object.assign(report, pushWithLease(ORIGIN, MIRROR, previous, target, env))
      } catch (error) {
        if (!/without (?:\x60?workflows?\x60? (?:permissions?|scope))/i.test(error.message)) throw error
        report.status = 'needs-ssh'
        report.reasons.push('The built-in token was denied permission to update workflow files')
      }
      if (report.status === 'pushed' || report.status === 'already') requireRemoteMirrorTip(report, ORIGIN, env, target)
    }
  } catch (error) {
    report.status = 'blocked'
    report.reasons.push(error.message)
  }
  saveMirrorReport(options, report, previous)
}

function mirrorPrevious(options) {
  if (options.head === undefined) throw new Error('--head is required for a pinned mirror update')
  return options.head ? sha(options.head, 'Previous mirror tip') : ''
}

async function mirrorPreflight(options) {
  const token = process.env.NEXT_SYNC_TOKEN
  const env = gitAuth(ORIGIN, token)
  const target = officialTarget(sha(options.target, 'Pinned mirror target'))
  const previous = mirrorPrevious(options)
  const report = mirrorReport(target, previous)
  try {
    const actual = remoteTip(ORIGIN, MIRROR, env, { missing: true })
    if (actual !== previous) {
      report.status = actual === target && !options['verify-key'] ? 'already' : 'raced'
      report.actual = actual
    } else {
      await requirePassiveMirror(target, previous, token)
      if (!options['verify-key'] && previous) {
        fetchCommit(ORIGIN, previous, env)
        if (!isAncestor(previous, target)) throw new Blocked('The official mirror update is not a fast-forward')
      }
      report.status = 'ready'
    }
  } catch (error) {
    report.reasons.push(error.message)
  }
  saveMirrorReport(options, report, previous)
}

function quoteShell(word) {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}

function mirrorSsh(options) {
  const repo = repository(process.env.GITHUB_REPOSITORY)
  if (ORIGIN !== 'https://github.com/' + repo + '.git') throw new Error('The mirror key is only used against the current GitHub repository')
  const remote = 'ssh://git@github.com/' + repo + '.git'
  const target = sha(options.target, 'Audited mirror target')
  const previous = mirrorPrevious(options)
  const report = mirrorReport(target, previous)
  const key = process.env.NEXT_MIRROR_DEPLOY_KEY
  delete process.env.NEXT_MIRROR_DEPLOY_KEY
  try {
    if (!key) throw new Blocked('Configure the NEXT_MIRROR_DEPLOY_KEY secret in the next-upstream-mirror environment')
    const directory = mkdtempSync(join(tmpdir(), 'dsh-next-mirror-ssh-'))
    try {
      const identity = join(directory, 'deploy_key')
      const knownHosts = join(directory, 'known_hosts')
      writeFileSync(identity, key.replaceAll('\r\n', '\n').trimEnd() + '\n', { mode: 0o600, flag: 'wx' })
      // GitHub Docs publishes this Ed25519 key at /authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints.
      writeFileSync(knownHosts, GITHUB_HOST_KEY + '\n', { mode: 0o600, flag: 'wx' })
      const env = {
        GIT_SSH_VARIANT: 'ssh',
        GIT_SSH_COMMAND: 'ssh -F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none'
          + ' -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519'
          + ' -o ConnectTimeout=20 -o UserKnownHostsFile=' + quoteShell(knownHosts) + ' -i ' + quoteShell(identity),
      }
      requireRemoteMirrorTip(report, remote, env, previous)
      if (report.status !== 'raced') {
        const dryRun = options['verify-key']
        const source = dryRun && previous ? previous : target
        Object.assign(report, pushWithLease(remote, MIRROR, previous, source, env, { dryRun }))
        if (report.status !== 'raced') {
          requireRemoteMirrorTip(report, remote, env, dryRun ? previous : target)
          if (dryRun && report.status !== 'raced') report.status = 'verified'
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  } catch (error) {
    report.status = 'blocked'
    report.reasons.push(error.message)
  }
  saveMirrorReport(options, report, previous)
}

async function recordBlock(options) {
  const report = readReport(required(options, 'report'))
  const api = apiClient(process.env.NEXT_SYNC_TOKEN)
  const kind = report.kind === 'mirror' ? 'mirror' : 'sync'
  const title = 'Next upstream ' + kind + ' blocked ' + report.base + ' → ' + report.target
  const marker = '<!-- next-upstream-' + kind + ':' + report.base + ':' + report.target + ' -->'
  for (let page = 1; ; page++) {
    const issues = await api('/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=' + page)
    const existing = issues.find(issue => !issue.pull_request && (issue.title === title || issue.body?.includes(marker)))
    if (existing) {
      output({ issue: String(existing.number) }, { summarize: true })
      return
    }
    if (issues.length < 100) break
  }
  const result = await api('/issues', {
    title,
    body: [
      marker,
      (report.kind === 'mirror' ? 'Previous mirror: `' : 'Community parent: `') + report.head + '`',
      'Official cursor: `' + report.base + '`',
      'Official target: `' + report.target + '`',
      'Candidate: `' + (report.candidate ?? 'unavailable') + '`',
      'Reason: ' + required(options, 'reason'),
      '',
      'See the [workflow run](' + process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY
        + '/actions/runs/' + process.env.GITHUB_RUN_ID + ') for logs and recovery artifacts.',
      'See `node scripts/next-upstream-sync.mjs --help` for the recovery commands.',
    ].join('\n'),
  })
  output({ issue: String(result.number) }, { summarize: true })
}

async function dispatch(options) {
  const candidate = sha(options.candidate, 'Release source')
  const token = process.env.NEXT_SYNC_TOKEN
  const env = gitAuth(ORIGIN, token)
  const tip = fetchCommit(ORIGIN, remoteTip(ORIGIN, MAIN, env), env)
  if (!isAncestor(candidate, tip)) throw new Error('Release source is not on main')
  const status = await dispatchRelease(apiClient(token), candidate)
  output({ status, candidate }, { summarize: true })
}

/**
 * Request release once for a published community SHA, failing closed after an uncertain delivery.
 * @param {Function} api - Repository-scoped GitHub REST request function.
 * @param {string} candidate - Published SHA used as the release source and receipt key.
 * @returns {Promise<string>} The dispatch or previously accepted status.
 */
export async function dispatchRelease(api, candidate) {
  const context = 'next-sync/release-dispatch'
  const { statuses } = await api('/commits/' + candidate + '/status')
  const receipt = statuses.find(status => status.context === context)
  if (receipt?.state === 'success') return 'already-dispatched'
  const workflow = '/actions/workflows/next-release.yml'
  const { workflow_runs: runs } = await api(workflow + '/runs?branch=main&head_sha=' + candidate + '&per_page=100')
  const runTitle = 'DSH Next Windows · ' + candidate
  let existing = runs.find(run => run.event === 'push' || run.display_title === runTitle)
  if (!existing && receipt?.created_at) {
    const recent = await api(workflow + '/runs?branch=main&event=workflow_dispatch&per_page=100&created='
      + encodeURIComponent('>=' + receipt.created_at))
    existing = recent.workflow_runs.find(run => run.display_title === runTitle)
  }
  if (existing) {
    await api('/statuses/' + candidate, { state: 'success', context, target_url: existing.html_url })
    return 'already-dispatched'
  }
  // A delivery with an unknown result requires a human readback. Retrying it could duplicate a release.
  if (receipt) throw new Error('Release dispatch is pending for ' + candidate + '. Check the release workflow before retrying manually.')
  await api('/statuses/' + candidate, { state: 'pending', context, description: 'Requesting the Next release workflow' })
  await api(workflow + '/dispatches', { ref: 'main', inputs: { source_sha: candidate } })
  await api('/statuses/' + candidate, { state: 'success', context, description: 'Next release dispatch accepted' })
  return 'dispatched'
}

const commands = { mirror, 'mirror-audit': mirrorAudit, 'mirror-preflight': mirrorPreflight, 'mirror-ssh': mirrorSsh,
  prepare, publish, checkout,
  resolve: resolveWorktree, finish, record: recordBlock, dispatch }
const help = String.raw`
Run with Node.js 24+ and Git supporting merge-tree --merge-base (Git 2.43+).
Use a complete clone. NEXT_SYNC_ORIGIN defaults to origin; NEXT_SYNC_UPSTREAM defaults to official GitHub.
The workflows use NEXT_SYNC_TOKEN for the HTTPS Next origin and API. Set the NEXT_MIRROR_DEPLOY_KEY
secret in the next-upstream-mirror environment for guarded SSH updates to upstream-main.
Deployments to that environment are restricted to main. Register the public key as a write deploy
key in the same repository. It can be verified using workflow_dispatch on main with
mode=mirror and verify_mirror_key=true. The probe reads upstream-main over SSH, performs a dry-run
push, and verifies the readback, even if upstream-main already matches the official target.
Run it with gh workflow run next-upstream-sync.yml --ref main -f mode=mirror -f verify_mirror_key=true.

  mirror [--target <official SHA>] [--out <new directory>] [--verify-key]
  mirror-audit --target <official SHA> [--creating]
  prepare --out <new directory> [--target <official SHA>] [--head <community SHA>]
  publish --head <verified parent> --target <official SHA> --candidate <verified SHA> --bundle <bundle>
  checkout --head <parent SHA> --target <official SHA> --candidate <SHA> --bundle <bundle>
  resolve --report <result.json> --bundle <candidate.bundle> --worktree <new directory>
  finish --report <result.json>
  dispatch --candidate <published SHA>

Recovery in a complete clone
1. Download the run's artifact. Pass absolute paths to resolve and choose a new worktree. This
   installs the proposed tree and restores Git's conflict stages. Review workflow changes in the
   disabled directory before explicitly applying any changes to active workflow guards.
2. In the recovery worktree, resolve and stage the changes. Use finish with the same report to
   create a single-parent commit containing the staged result, synchronized versions and cursor.
3. Check out the emitted SHA in a separate worktree and run the Next sync validation checks.
   After review, fetch origin/main, verify it still equals the reported parent, and push from
   the tested checkout with git push --force-with-lease=refs/heads/main:<parent> origin HEAD:refs/heads/main.
   If main advanced, use a fresh report and retain the original worktree for comparison.
`

async function runCli() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help') console.log(help.trim())
  else {
    if (!Object.hasOwn(commands, command)) throw new Error('Unknown command ' + command + '. See --help.')
    const { values } = parseArgs({
      args,
      options: {
        ...Object.fromEntries(['out', 'target', 'head', 'candidate', 'bundle', 'report', 'worktree', 'reason']
          .map(key => [key, { type: 'string' }])),
        creating: { type: 'boolean' },
        'verify-key': { type: 'boolean' },
      },
    })
    await commands[command](values)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch(error => {
    console.error('next-upstream-sync: ' + JSON.stringify(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
