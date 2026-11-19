/** End-to-end Git fixtures for the Next synchronization CLI. */

import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { dispatchRelease } from './next-upstream-sync.mjs'

const script = fileURLToPath(new URL('./next-upstream-sync.mjs', import.meta.url))
const exec = promisify(execFile)
const cursor = '.github/next-upstream-base'
const active = '.github/workflows/'
const disabled = '.github/upstream-workflows/'
const mailboxPackages = [
  'packages/api/session-mailbox-controller',
  'packages/client/ui-session-mailbox',
  'packages/interaction/session-mailbox',
]
const lockfile = 'pnpm-lock.yaml'
const guarded = 'name: Official only\njobs:\n  example:\n    if: github.repository == "deepseek-ai/deepseek-harness"\n    runs-on: ubuntu-24.04\n'

function put(root, path, contents) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function lockfileText(paths) {
  return 'lockfileVersion: \'9.0\'\n\nimporters:\n  .: {}\n'
    + paths.map(path => '  ' + path + ': {}\n').join('') + '\npackages: {}\n'
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-next-sync-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const origin = join(directory, 'origin.git')
  const upstream = join(directory, 'upstream.git')
  const community = join(directory, 'community')
  const official = join(directory, 'official')
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:GIT_|GITHUB_|NEXT_SYNC_)/i.test(key))),
    GIT_CONFIG_GLOBAL: join(directory, 'empty-global-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Sync test',
    GIT_AUTHOR_EMAIL: 'sync-test@example.invalid',
    GIT_COMMITTER_NAME: 'Sync test',
    GIT_COMMITTER_EMAIL: 'sync-test@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-19T12:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-19T12:00:00Z',
    NEXT_SYNC_ORIGIN: origin,
    NEXT_SYNC_UPSTREAM: upstream,
  }
  function git(cwd, ...args) {
    return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trimEnd()
  }
  function gitProbe(cwd, ...args) {
    return spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true })
  }
  function commit(repo, message) {
    git(repo, 'add', '--all')
    git(repo, 'commit', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')
  }
  function node(cwd, ...args) {
    return JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' }))
  }
  function nodeProbe(cwd, ...args) {
    return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
  }
  function prepare(repo, label, target) {
    const out = join(directory, label)
    const args = target ? ['--target', target] : []
    const proposal = node(repo, 'prepare', '--out', out, ...args)
    const report = join(out, 'result.json')
    return { ...proposal, report, bundle: join(out, 'candidate.bundle') }
  }
  function publishArgs(proposal) {
    return ['publish', '--head', proposal.head, '--target', proposal.target,
      '--candidate', proposal.candidate, '--bundle', proposal.bundle]
  }
  function worker(label) {
    const path = join(directory, label)
    git(directory, 'clone', '--no-tags', '--branch', 'main', origin, path)
    return path
  }

  git(directory, 'init', '--bare', '--template=', '--initial-branch=main', origin)
  git(directory, 'init', '--bare', '--template=', '--initial-branch=master', upstream)
  git(directory, 'init', '--template=', '--initial-branch=main', community)
  git(directory, 'init', '--template=', '--initial-branch=master', official)
  const initialVersion = '0.2.2-rc.5'
  put(official, 'package.json', JSON.stringify({ name: 'root', version: initialVersion }) + '\n')
  put(official, 'packages/core/official/package.json', JSON.stringify({ name: 'official', version: initialVersion }) + '\n')
  put(official, lockfile, lockfileText(['packages/core/official']))
  put(official, 'shared.txt', 'first line\nbase middle\nlast line\n')
  put(official, active + 'ci.yml', 'name: Official first\n')
  put(official, active + 'official-only.yml', guarded)
  const base = commit(official, 'Official rc.5')
  git(official, 'push', upstream, 'HEAD:refs/heads/master')

  for (const path of ['package.json', 'packages/core/official/package.json', 'shared.txt']) {
    put(community, path, readFileSync(join(official, path)))
  }
  put(community, cursor, base + '\n')
  put(community, active + 'official-only.yml', guarded)
  put(community, active + 'next-release.yml', 'name: Next release\n')
  put(community, disabled + 'ci.yml.disabled', 'name: Official first\n')
  put(community, lockfile, lockfileText(['packages/core/official', ...mailboxPackages]))
  for (const path of mailboxPackages) {
    put(community, path + '/package.json', JSON.stringify({ name: path.split('/').at(-1), version: initialVersion }) + '\n')
  }
  put(community, 'community.txt', 'Next-only behavior\n')
  const head = commit(community, 'Next starts at the rc.5 cursor')
  git(community, 'push', origin, 'HEAD:refs/heads/main')

  function advance(message) {
    const target = commit(official, message)
    git(official, 'push', upstream, 'HEAD:refs/heads/master')
    return target
  }
  function tip() {
    return git(origin, 'rev-parse', 'refs/heads/main')
  }

  return { directory, origin, upstream, community, official, base, head, env, git, gitProbe, commit,
    node, nodeProbe, prepare, publishArgs, worker, advance, tip }
}

test('three linear rounds retain community packages, importers, and active guards', t => {
  const f = fixture(t)
  const planner = f.worker('planner')
  const publisher = f.worker('publisher')
  let parent = f.head
  let cursorBefore = f.base
  const firstMirror = f.node(planner, 'mirror')
  assert.equal(firstMirror.status, 'pushed')
  assert.equal(firstMirror.target, f.base)
  assert.equal(f.node(planner, 'mirror').status, 'already')
  assert.equal(f.git(f.origin, 'rev-parse', 'refs/heads/upstream-main'), f.base)

  for (const round of [6, 7, 8]) {
    const version = '0.2.2-rc.' + round
    put(f.official, 'package.json', JSON.stringify({ name: 'root', version }) + '\n')
    put(f.official, 'packages/core/official/package.json', JSON.stringify({ name: 'official', version }) + '\n')
    put(f.official, lockfile, 'settings:\n  fixtureRelease: ' + round + '\n\n' + lockfileText(['packages/core/official']))
    put(f.official, 'official.txt', 'Official change ' + round + '\n')
    put(f.official, active + 'ci.yml', 'name: Official ' + round + '\n')
    put(f.official, active + 'added.yaml', 'name: New upstream action ' + round + '\n')
    put(f.official, active + 'official-only.yml', guarded + '    timeout-minutes: ' + round + '\n')
    const target = f.advance('Official rc.' + round)
    const proposal = f.prepare(planner, 'round-' + round)
    assert.deepEqual([proposal.status, proposal.head, proposal.base, proposal.target], ['ready', parent, cursorBefore, target])
    assert.equal(f.prepare(planner, 'repeat-' + round, target).candidate, proposal.candidate)
    assert.equal(f.tip(), parent)

    const validator = f.worker('validator-' + round)
    f.git(validator, 'fetch', f.origin, 'refs/heads/main')
    execFileSync(process.execPath, [script, 'checkout', '--head', parent, '--target', target,
      '--candidate', proposal.candidate, '--bundle', proposal.bundle], { cwd: validator, env: f.env, stdio: 'pipe' })
    assert.equal(f.git(validator, 'rev-parse', 'HEAD'), proposal.candidate)
    assert.equal(readFileSync(join(validator, 'official.txt'), 'utf8').trimEnd(), 'Official change ' + round)
    assert.equal(readFileSync(join(validator, active + 'official-only.yml'), 'utf8'), guarded)

    assert.equal(f.node(publisher, ...f.publishArgs(proposal)).status, 'pushed')
    assert.equal(f.node(publisher, ...f.publishArgs(proposal)).status, 'already')
    assert.equal(f.tip(), proposal.candidate)
    assert.equal(f.git(f.origin, 'rev-list', '--parents', '-n', '1', f.tip()), f.tip() + ' ' + parent)
    assert.equal(f.git(f.origin, 'show', f.tip() + ':' + cursor), target)
    assert.equal(f.git(f.origin, 'show', f.tip() + ':community.txt'), 'Next-only behavior')
    const lock = f.git(f.origin, 'show', f.tip() + ':' + lockfile)
    assert.ok(lock.includes('fixtureRelease: ' + round + '\n'))
    for (const path of mailboxPackages) {
      assert.equal(JSON.parse(f.git(f.origin, 'show', f.tip() + ':' + path + '/package.json')).version, version)
      assert.ok(lock.includes('  ' + path + ': {}\n'))
    }
    assert.equal(f.git(f.origin, 'show', f.tip() + ':' + disabled + 'ci.yml.disabled'), 'name: Official ' + round)
    assert.equal(f.git(f.origin, 'show', f.tip() + ':' + disabled + 'added.yaml.disabled'), 'name: New upstream action ' + round)
    assert.ok(f.git(f.origin, 'show', f.tip() + ':' + disabled + 'official-only.yml.disabled').includes('timeout-minutes: ' + round))
    assert.equal(f.gitProbe(f.origin, 'cat-file', '-e', f.tip() + ':' + active + 'added.yaml').status, 128)
    assert.equal(f.git(f.origin, 'diff', '--name-only', parent, f.tip(), '--', active), '')
    assert.equal(f.prepare(planner, 'current-' + round, target).status, 'current')
    assert.equal(f.prepare(planner, 'stale-' + round, cursorBefore).status, 'stale')
    parent = f.tip()
    cursorBefore = target
  }
  assert.equal(f.git(f.origin, 'rev-list', '--count', f.head + '..' + f.tip()), '3')
})

test('concurrent publications elect one fast-forward and read back the winner', async t => {
  const f = fixture(t)
  const first = f.worker('first')
  const second = f.worker('second')
  put(f.official, 'upstream.txt', 'first target\n')
  const targetOne = f.advance('First target')
  put(f.official, 'upstream.txt', 'second target\n')
  const targetTwo = f.advance('Second target')
  const one = f.prepare(first, 'first-proposal', targetOne)
  const two = f.prepare(second, 'second-proposal', targetTwo)
  assert.equal(one.head, two.head)
  const results = await Promise.all([ [first, one], [second, two] ].map(async ([cwd, proposal]) => {
    const { stdout } = await exec(process.execPath, [script, ...f.publishArgs(proposal)], { cwd, env: f.env, windowsHide: true })
    return JSON.parse(stdout)
  }))
  assert.deepEqual(results.map(result => result.status).sort(), ['pushed', 'raced'])
  for (const result of results) assert.equal(result.actual, f.tip())
  assert.ok([one.candidate, two.candidate].includes(f.tip()))
  assert.equal(f.git(f.origin, 'rev-parse', 'refs/heads/main^'), f.head)
})

test('conflict recovery restores all stages and keeps the staged human resolution', t => {
  const f = fixture(t)
  put(f.community, 'shared.txt', 'first line\ncommunity middle\nlast line\n')
  const communityHead = f.commit(f.community, 'Community edits the middle')
  f.git(f.community, 'push', f.origin, 'HEAD:refs/heads/main')
  put(f.official, 'shared.txt', 'first line\nupstream middle\nlast line\n')
  const target = f.advance('Official edits the middle')
  const planner = f.worker('planner')
  const proposal = f.prepare(planner, 'conflicted')
  assert.equal(proposal.status, 'blocked')
  const report = JSON.parse(readFileSync(proposal.report, 'utf8'))
  assert.deepEqual(report.conflicts.map(entry => [entry.path, entry.stage]),
    [['shared.txt', 1], ['shared.txt', 2], ['shared.txt', 3]])
  assert.equal(f.tip(), communityHead)
  assert.equal(f.git(planner, 'status', '--short'), '')

  const worktree = join(f.directory, 'human-review')
  const resolve = ['resolve', '--report', proposal.report, '--bundle', proposal.bundle, '--worktree', worktree]
  f.node(planner, ...resolve)
  assert.equal(f.git(worktree, 'rev-parse', 'HEAD'), communityHead)
  assert.equal(f.git(worktree, 'status', '--short', '--', 'shared.txt'), 'UU shared.txt')
  assert.match(readFileSync(join(worktree, 'shared.txt'), 'utf8'), /\|{7}/)
  assert.equal(f.git(worktree, 'show', ':1:shared.txt').split('\n')[1], 'base middle')
  assert.equal(f.git(worktree, 'show', ':2:shared.txt').split('\n')[1], 'community middle')
  assert.equal(f.git(worktree, 'show', ':3:shared.txt').split('\n')[1], 'upstream middle')
  put(worktree, 'shared.txt', 'first line\nhuman integrated both\nlast line\n')
  f.git(worktree, 'add', 'shared.txt')

  assert.equal(f.prepare(planner, 'conflicted-again').candidate, proposal.candidate)
  assert.match(f.nodeProbe(planner, ...resolve).stderr, /already exists/)
  assert.equal(f.git(worktree, 'show', ':shared.txt').split('\n')[1], 'human integrated both')
  const communityLock = readFileSync(join(worktree, lockfile))
  put(worktree, lockfile, lockfileText(['packages/core/official']))
  f.git(worktree, 'add', lockfile)
  assert.match(f.nodeProbe(worktree, 'finish', '--report', proposal.report).stderr, /lost community importers/)
  put(worktree, lockfile, communityLock)
  f.git(worktree, 'add', lockfile)
  const finished = f.node(worktree, 'finish', '--report', proposal.report)
  assert.equal(f.git(worktree, 'rev-parse', finished.candidate + '^'), communityHead)
  assert.equal(f.git(worktree, 'show', finished.candidate + ':' + cursor), target)
  assert.equal(f.git(worktree, 'show', finished.candidate + ':shared.txt').split('\n')[1], 'human integrated both')
  assert.equal(f.tip(), communityHead)
})

test('upstream changes to an existing guard or Next trust path require review', t => {
  const f = fixture(t)
  put(f.official, active + 'official-only.yml', guarded.replace('deepseek-ai/deepseek-harness', 'xue-ding-e/DSH-Next'))
  put(f.official, active + 'next-release.yml', 'name: Colliding community workflow\n')
  put(f.official, 'scripts/next-upstream-sync.mjs', 'upstream collision\n')
  put(f.official, 'apps/desktop/scripts/next-github-release.ps1', 'official release helper\n')
  f.advance('Change a guard and add trust path collisions')
  const planner = f.worker('planner')
  const proposal = f.prepare(planner, 'guard-review')
  assert.equal(proposal.status, 'blocked')
  const report = JSON.parse(readFileSync(proposal.report, 'utf8'))
  assert.ok(report.reasons.some(reason => reason.includes('Official repository guard changed')))
  assert.ok(report.reasons.some(reason => reason.includes('upstream-sync.mjs')))
  assert.ok(report.reasons.some(reason => reason.includes('next-release.yml')))
  assert.ok(report.reasons.some(reason => reason.includes('next-github-release.ps1')))
  assert.equal(f.git(planner, 'show', proposal.candidate + ':' + active + 'official-only.yml'), guarded.trimEnd())
  assert.equal(f.git(planner, 'show', proposal.candidate + ':' + active + 'next-release.yml'), 'name: Next release')
  assert.equal(f.tip(), f.head)
})

test('publication rejects an artifact with the expected parent and cursor but a different tree', t => {
  const f = fixture(t)
  put(f.official, 'upstream.txt', 'verified upstream change\n')
  f.advance('Ordinary upstream change')
  const planner = f.worker('planner')
  const proposal = f.prepare(planner, 'verified')
  const interloper = f.worker('interloper')
  execFileSync(process.execPath, [script, 'checkout', '--head', proposal.head, '--target', proposal.target,
    '--candidate', proposal.candidate, '--bundle', proposal.bundle], { cwd: interloper, env: f.env, stdio: 'pipe' })
  put(interloper, 'upstream.txt', 'different tree\n')
  f.git(interloper, 'add', 'upstream.txt')
  const tree = f.git(interloper, 'write-tree')
  const forged = f.git(interloper, 'commit-tree', tree, '-p', proposal.head, '-m', 'Different tree')
  const ref = 'refs/heads/forged'
  f.git(interloper, 'update-ref', ref, forged)
  const bundle = join(f.directory, 'forged.bundle')
  f.git(interloper, 'bundle', 'create', bundle, ref, '^' + proposal.head)

  const publisher = f.worker('publisher')
  const result = f.nodeProbe(publisher, ...f.publishArgs({ ...proposal, candidate: forged, bundle }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /recomputed integration tree/)
  assert.equal(f.tip(), f.head)
  assert.ok(existsSync(proposal.bundle))
})

test('mirror audit accepts excluded branches and stops when raw triggers could run on a mirror push', t => {
  const f = fixture(t)
  const planner = f.worker('planner')
  put(f.official, active + 'ci.yml', 'on:\n  push:\n    branches: [main, master, "release/dsh-[0-9]+", "preview/**"]\n')
  put(f.official, active + 'official-only.yml', 'on:\n  push:\n    branches-ignore:\n      - upstream-main\n')
  put(f.official, active + 'manual.yml', '"on": [schedule, workflow_dispatch]\n')
  put(f.official, active + 'tag.yml', 'on:\n  push:\n    tags: ["v*"]\n')
  const allowed = f.advance('No workflow runs on upstream-main')
  assert.deepEqual(f.node(planner, 'mirror-audit', '--target', allowed, '--creating').reasons, [])

  put(f.official, active + 'wildcard.yml', 'on:\n  push:\n    branches: ["*"]\n')
  put(f.official, active + 'literal.yml', 'on:\n  push:\n    branches: [upstream-main]\n')
  put(f.official, active + 'inline.yml', 'on: [push, workflow_dispatch]\n')
  put(f.official, active + 'create.yml', 'on: create\n')
  put(f.official, active + 'alias.yml', 'on: *events\n')
  const blocked = f.advance('Unrestricted and unsupported triggers')
  const inspection = f.nodeProbe(planner, 'mirror-audit', '--target', blocked, '--creating')
  assert.equal(inspection.status, 1)
  assert.deepEqual(JSON.parse(inspection.stdout).reasons.map(reason => reason.split(':', 1)[0]), [
    active + 'alias.yml', active + 'create.yml', active + 'inline.yml', active + 'literal.yml', active + 'wildcard.yml',
  ])
  const update = f.nodeProbe(planner, 'mirror-audit', '--target', blocked)
  assert.equal(update.status, 1)
  assert.ok(JSON.parse(update.stdout).reasons.every(reason => !reason.includes('create.yml')))
  assert.equal(f.gitProbe(f.origin, 'rev-parse', '--verify', 'refs/heads/upstream-main').status, 128)
})

test('the mirror key probe runs on the same SHA and leaves the pinned ref unchanged', t => {
  const f = fixture(t)
  const planner = f.worker('planner')
  assert.equal(f.node(planner, 'mirror').status, 'pushed')
  const prepared = f.node(planner, 'mirror', '--verify-key')
  assert.deepEqual([prepared.status, prepared.previous, prepared.target], ['needs-ssh', f.base, f.base])

  // Git's URL rewrite sends the SSH-facing command through a local receive-pack.
  const repo = 'fixture/next'
  f.git(planner, 'config', '--local', 'url.' + pathToFileURL(f.origin).href + '.insteadOf',
    'ssh://git@github.com/' + repo + '.git')
  const env = { ...f.env, GITHUB_REPOSITORY: repo, NEXT_SYNC_ORIGIN: 'https://github.com/' + repo + '.git' }
  const args = ['mirror-ssh', '--head', prepared.previous, '--target', prepared.target, '--verify-key']
  const missing = JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd: planner, env, encoding: 'utf8' }))
  assert.equal(missing.status, 'blocked')
  assert.match(missing.reasons[0], /NEXT_MIRROR_DEPLOY_KEY/)
  env.NEXT_MIRROR_DEPLOY_KEY = 'fixture key handled by the local Git transport'
  const verified = JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd: planner, env, encoding: 'utf8' }))
  assert.deepEqual([verified.status, verified.actual], ['verified', f.base])
  assert.equal(f.git(f.origin, 'rev-parse', 'refs/heads/upstream-main'), f.base)
})

test('an accepted release dispatch is issued once for its candidate SHA', async () => {
  const source = 'a'.repeat(40)
  const statuses = []
  const requests = []
  const api = async (path, data) => {
    if (path.endsWith('/status')) return { statuses }
    if (path.startsWith('/statuses/')) {
      statuses.unshift(data)
      return {}
    }
    if (path.includes('/runs?')) {
      return { workflow_runs: [{ event: 'workflow_dispatch', display_title: 'DSH Next Windows · ' + 'b'.repeat(40) }] }
    }
    assert.ok(path.endsWith('/next-release.yml/dispatches'))
    requests.push(data)
  }
  assert.equal(await dispatchRelease(api, source), 'dispatched')
  assert.equal(await dispatchRelease(api, source), 'already-dispatched')
  assert.deepEqual(requests, [{ ref: 'main', inputs: { source_sha: source } }])
})

test('a lost release response reuses the claim and recognizes the exact source on readback', async () => {
  const source = 'b'.repeat(40)
  const statuses = []
  const visible = []
  let requests = 0
  const api = async (path, data) => {
    if (path.endsWith('/status')) return { statuses }
    if (path.startsWith('/statuses/')) {
      statuses.unshift({ ...data, created_at: '2026-11-19T12:00:00Z' })
      return {}
    }
    if (path.includes('head_sha=')) return { workflow_runs: [] }
    if (path.includes('event=workflow_dispatch')) return { workflow_runs: visible }
    assert.ok(path.endsWith('/next-release.yml/dispatches'))
    requests++
    throw new Error('Connection lost after the POST')
  }
  await assert.rejects(dispatchRelease(api, source), /Connection lost/)
  await assert.rejects(dispatchRelease(api, source), /Release dispatch is pending/)
  assert.equal(requests, 1)
  visible.push({ event: 'workflow_dispatch', display_title: 'DSH Next Windows · ' + source })
  assert.equal(await dispatchRelease(api, source), 'already-dispatched')
  assert.equal(requests, 1)
})
