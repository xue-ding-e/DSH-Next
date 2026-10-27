import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { runCommand } from './run-command.mjs'
import { verifyProductGraph } from './product-identity.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertNegativeControl, assertWorkspaceNegativeControl, assertPassing, WORKSPACE_REGRESSION, BASE, ROWS, ROW_TEST, REGRESSION, UNIT_FILES } from './vitest-evidence.mjs'

const root = resolve(process.argv[2])
const evidence = resolve(process.argv[3])
mkdirSync(evidence, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: root })
const { productSha, sessionSha } = verifyProductGraph(root)
assert.equal(git('status', '--porcelain', '--untracked-files=no').toString(), '')
const path = join(root, ROWS)
const original = readFileSync(path)
assert.deepEqual(original, git('show', `${productSha}:${ROWS}`))
const before = git('show', `${BASE}:${ROWS}`)
assert.notDeepEqual(before, original)
const testBytes = readFileSync(join(root, ROW_TEST))

async function run(name, args) {
  const output = join(evidence, `${name}.json`)
  const result = await runCommand('pnpm', ['exec', 'vitest', 'run', ...args, '--maxWorkers=2',
    '--reporter=default', '--reporter=json', `--outputFile=${output}`], {
    cwd: root, env: { ...process.env, NO_COLOR: '1' }, timeout: 12 * 60_000,
  })
  assert.equal(result.error, undefined, `${name}: process error/timeout`)
  assert.equal(result.signal, null, `${name}: process signal`)
  return [result, JSON.parse(readFileSync(output, 'utf8'))]
}

try {
  writeFileSync(path, before)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readFileSync(join(root, ROW_TEST)), testBytes)
  const [result, report] = await run('before', ['--project=thread-safe', ROW_TEST, '-t', REGRESSION])
  assertNegativeControl(result, report)
  console.log('Verified negative control: both archived states fail at the intended context-menu assertion.')
} finally {
  writeFileSync(path, original)
  assert.deepEqual(readFileSync(path), original)
}
try {
  writeFileSync(path, git('show', `${sessionSha}:${ROWS}`))
  assert.deepEqual(readFileSync(join(root, ROW_TEST)), testBytes)
  const [result, report] = await run('workspace-before', ['--project=thread-safe', ROW_TEST, '-t', WORKSPACE_REGRESSION])
  assertWorkspaceNegativeControl(result, report)
  console.log('Verified workspace negative control at the intended right-click assertion.')
} finally {
  writeFileSync(path, original)
  assert.deepEqual(readFileSync(path), original)
}
const [result, report] = await run('after', ['--project=thread-safe', ...UNIT_FILES])
assertPassing(result, report, UNIT_FILES)
assert.equal(git('diff', '--name-only').toString(), '')
console.log('Verified candidate: all reviewed original-config Vitest files passed with no skipped tests.')
