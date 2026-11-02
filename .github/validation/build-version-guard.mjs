import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
export const PRODUCT = '275192ff0c4857c137eeaf96f5320d3034c19d35'
export const PREVIOUS_CONTROL = '003b110343268cd563e81433d0b1cbce8b65924b'
export const PREVIOUS_BLOBS = ['a0a72190d6a0e097385bb64774525789ed4cd1dd', 'dca2901b8a9ae0a23bc43fb2615c974c77766d08', 'f6165d4b65e7ecd8f22011384a06714e53492512']
export const BASE = 'fa8c664daeaf4cea52f6034474dcc4d57de10dd7'
export const DECLARATION = 'apps/desktop/scripts/desktop-build-version.d.mts'
export const BLOB = '10d6b04084540b527d064c864f5bc3ff11e6c4bf'
export const CONTROLS = ['.github/validation/build-version-guard.mjs', '.github/validation/build-version-guard.test.mjs', '.github/workflows/next-context-menu-validation.yml']
export function checkIdentity(x) {
  assert.equal(x.repo, 'xue-ding-e/DSH-Next')
  assert(['push', 'workflow_dispatch'].includes(x.event))
  if (x.event === 'push') {
    assert.equal(x.before, PREVIOUS_CONTROL)
    assert.equal(x.after, x.eventSha)
    assert.equal(x.deleted, false)
    assert.equal(x.forced, false)
    assert.equal(x.created, false)
  }
  assert.equal(x.ref, 'refs/heads/validation/desktop-build-version-channel')
  for (const sha of [x.expectedControl, x.expectedProduct]) assert.match(sha ?? '', /^[0-9a-f]{40}$/)
  assert.equal(x.control, x.expectedControl)
  assert.equal(x.eventSha, x.expectedControl)
  assert.equal(x.product, x.expectedProduct)
  assert.equal(x.product, PRODUCT)
  assert.deepEqual(x.controlParents, [PREVIOUS_CONTROL])
  assert.deepEqual(x.previousControlParents, [PRODUCT])
  assert.deepEqual(x.previousControlFiles, CONTROLS)
  assert.deepEqual(x.previousControlBlobs, PREVIOUS_BLOBS)
  assert.deepEqual(x.productParents, [BASE])
  assert.deepEqual(x.productFiles, [DECLARATION])
  assert.deepEqual([...x.controlFiles].sort(), CONTROLS)
  assert.deepEqual([...x.productToControlFiles].sort(), CONTROLS)
  assert.equal(x.blob, BLOB)
  assert.equal(x.productStatus, '')
  assert.equal(x.controlStatus, '')
}
export function checkMemory(physical, limits) {
  assert(Number.isFinite(physical) && physical > 0)
  const caps = limits.map(v => {
    if (v.trim() === 'max') return Infinity
    assert(/^\d+$/.test(v.trim()), 'unrecognized cgroup memory limit')
    const n = Number(v.trim()); assert(n > 0); return n
  })
  const effective = Math.min(physical, ...caps)
  assert(effective >= 12 * 1024 ** 3, `effective memory ${effective} below 12 GiB`)
  return effective
}
export function inspectMemory() {
  const mem = readFileSync('/proc/meminfo', 'utf8').match(/^MemTotal:\s+(\d+) kB$/m)
  assert(mem, 'cannot inspect physical RAM')
  const memberships = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n')
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
  const limits = []; let hierarchyFound = false
  for (const line of mounts) {
    const [left, right] = line.split(' - '); const fields = left.split(' '); const kind = right.split(' ')[0]
    if (kind !== 'cgroup2' && !(kind === 'cgroup' && right.split(' ')[2].split(',').includes('memory'))) continue
    const member = memberships.find(x => kind === 'cgroup2' ? x.startsWith('0::') : x.split(':')[1].split(',').includes('memory'))
    assert(member, 'cgroup membership unavailable')
    const mountRoot = fields[3], mountPoint = fields[4], memberPath = member.split(':')[2]
    assert(!/[\\]/.test(mountRoot + mountPoint + memberPath), 'escaped mount path needs review')
    const suffix = mountRoot === '/' ? memberPath : memberPath.startsWith(mountRoot + '/') ? memberPath.slice(mountRoot.length) : memberPath === mountRoot ? '/' : null
    assert(suffix !== null, 'cannot resolve cgroup namespace safely')
    let p = resolve(mountPoint, '.' + suffix); const root = resolve(mountPoint)
    assert(p === root || p.startsWith(root + '/'))
    const filename = kind === 'cgroup2' ? 'memory.max' : 'memory.limit_in_bytes'
    assert(existsSync(p + '/' + filename), 'current cgroup memory limit missing')
    while (true) {
      if (existsSync(p + '/' + filename)) limits.push(readFileSync(p + '/' + filename, 'utf8'))
      if (p === root) break
      p = resolve(p, '..')
    }
    hierarchyFound = true
  }
  assert(hierarchyFound, 'no inspectable memory cgroup; fail closed')
  return checkMemory(Number(mem[1]) * 1024, limits)
}
export function checkTests(report) {
  assert.equal(report.success, true)
  assert.equal(report.numTotalTests, 25)
  assert.equal(report.numPassedTests, 25)
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numPendingTests, 0)
  assert.equal(report.numTodoTests, 0)
  assert.equal(report.testResults.length, 1)
  const file = report.testResults[0]
  assert(file.name.endsWith('/apps/desktop/tests/desktop-build-version.spec.ts'))
  assert.equal(file.assertionResults.length, 25)
  for (const test of file.assertionResults) assert.equal(test.status, 'passed')
}
if (import.meta.main) {
  if (process.argv[2] === 'tests') {
    checkTests(JSON.parse(readFileSync(process.argv[3], 'utf8')))
  } else {
    const control = resolve(process.argv[2]), product = resolve(process.argv[3])
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const parents = cwd => git(cwd, 'show', '-s', '--format=%P', 'HEAD').split(' ')
    const files = (cwd, ref = 'HEAD') => git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', ref).split('\n')
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    checkIdentity({ repo: process.env.GITHUB_REPOSITORY, event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      expectedControl: process.env.EXPECTED_CONTROL_SHA, expectedProduct: process.env.EXPECTED_PRODUCT_SHA,
      before: event.before, after: event.after, created: event.created, deleted: event.deleted, forced: event.forced,
      eventSha: process.env.GITHUB_SHA, control: git(control, 'rev-parse', 'HEAD'), product: git(product, 'rev-parse', 'HEAD'),
      controlParents: parents(control), previousControlParents: git(control, 'show', '-s', '--format=%P', PREVIOUS_CONTROL).split(' '),
      previousControlFiles: files(control, PREVIOUS_CONTROL).sort(),
      previousControlBlobs: CONTROLS.map(path => git(control, 'rev-parse', `${PREVIOUS_CONTROL}:${path}`)),
      productToControlFiles: git(control, 'diff', '--name-only', PRODUCT, 'HEAD').split('\n'),
      productParents: parents(product), controlFiles: files(control), productFiles: files(product),
      blob: git(product, 'rev-parse', `HEAD:${DECLARATION}`), productStatus: git(product, 'status', '--porcelain'), controlStatus: git(control, 'status', '--porcelain') })
    console.log('Verified exact product/control graph; effective memory bytes:', inspectMemory())
  }
}
