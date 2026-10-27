import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { runCommand } from './run-command.mjs'
import { verify } from './stage2.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertPassing, BROWSER_FILE, BROWSER_TEST, BROWSER_WORKSPACE_TEST } from './vitest-evidence.mjs'

const root = resolve(process.argv[2])
const evidence = resolve(process.argv[3])
mkdirSync(evidence, { recursive: true })
const path = join(root, BROWSER_FILE)
const original = readFileSync(path)
const git = (...args) => execFileSync('git', args, { cwd: root })
const manifest = JSON.parse(readFileSync(new URL('./stage2-manifest.json', import.meta.url)))
verify(root, manifest)
const productSha = manifest.final
assert.deepEqual(original, git('show', `${productSha}:${BROWSER_FILE}`))
const fragment = readFileSync(new URL('./context-menu-browser.test-fragment.ts', import.meta.url))
const output = join(evidence, 'browser.json')
async function execute(args, timeout) {
  const result = await runCommand('pnpm', args, { cwd: root, timeout })
  assert.equal(result.error, undefined, 'process error/timeout')
  assert.equal(result.signal, null, 'process terminated by signal')
  return result
}
try {
  writeFileSync(path, Buffer.concat([original, fragment]))
  // The existing Host-face file is already in both aggregate program lists.
  // Compile the added browser assertions using the artifacts just built from the exact pinned product.
  assert.equal((await execute(['run', 'build:check'], 40 * 60_000)).status, 0)
  const result = await execute(['exec', 'vitest', 'run', '--config=vitest.web.config.ts', BROWSER_FILE,
    '-t', `${BROWSER_TEST}|${BROWSER_WORKSPACE_TEST}`, '--maxWorkers=1', '--reporter=default', '--reporter=json',
    `--outputFile=${output}`], 10 * 60_000)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assertPassing(result, report, [BROWSER_FILE], [BROWSER_TEST, BROWSER_WORKSPACE_TEST])
  console.log('Verified Chromium: real scaffold, unchanged selection, target action ownership, archived row, and dismissal.')
} finally {
  writeFileSync(path, original)
  assert.deepEqual(readFileSync(path), original)
}
assert.equal(git('diff', '--name-only').toString(), '')
