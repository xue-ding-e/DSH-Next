import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export const INITIAL_MAIN = 'fae57ca3e87f40b0fdb0500334d5519a212ae1c2'
export const CANONICAL_WORKSPACE = 'c67ff3501c2a7d38d3cf60eb21f7634eb40b68e7'
export const WORKSPACE_PATCH_SHA256 = '2747e5ad6c950f1a4d1ffe69e00298c46c75a62dd68f40709125470f5855f6c7'
export const CANONICAL_PRODUCT = '36833515300e6ec74877dc489e05a4aa15f82c4c'
export const CANONICAL_PATCH_SHA256 = '13f9a4854336a0d5d48f1ed292445fdfedfcb5754cf1757bd3fdf2eeed17d470'
const controlFiles = [
  '.github/workflows/next-context-menu-validation.yml',
  ...['context-menu-browser.mjs', 'context-menu-browser.test-fragment.ts', 'context-menu-unit.mjs',
    'heavy-queue.mjs', 'product-identity.mjs', 'run-command.mjs', 'vitest-evidence.mjs',
    'vitest-evidence.test.mjs'].map(name => `.github/validation/${name}`),
].sort()

/** Require the reviewed D -> C -> S -> W graph and byte-identical canonical product diff, not just matching branch names. */
export function verifyProductGraph(root) {
  const productSha = process.env.EXPECTED_PRODUCT_SHA
  const controlSha = process.env.EXPECTED_CONTROL_SHA
  const automationSha = process.env.EXPECTED_AUTOMATION_SHA
  assert.match(productSha ?? '', /^[0-9a-f]{40}$/)
  assert.match(controlSha ?? '', /^[0-9a-f]{40}$/)
  assert.match(automationSha ?? '', /^[0-9a-f]{40}$/)
  assert.equal(process.env.GITHUB_SHA, productSha, 'the dispatched immutable commit must be the reviewed product commit')
  const git = (...args) => execFileSync('git', args, { cwd: root })
  const text = (...args) => git(...args).toString().trim()
  assert.equal(text('rev-parse', 'HEAD'), productSha)
  const sessionSha = text('show', '-s', '--format=%P', productSha)
  assert.match(sessionSha, /^[0-9a-f]{40}$/, 'W must have exactly one parent, S')
  assert.equal(text('show', '-s', '--format=%P', sessionSha), controlSha, 'S must have exactly one parent, C')
  assert.equal(text('show', '-s', '--format=%P', controlSha), automationSha, 'C must have exactly one parent, D')
  assert.equal(text('show', '-s', '--format=%P', automationSha), INITIAL_MAIN, 'D must have exactly the initial main parent')
  assert.deepEqual(text('diff', '--no-renames', '--name-only', INITIAL_MAIN, automationSha).split('\n').sort(),
    ['.github/dependabot.yml', '.github/upstream-dependabot.yml.disabled'])
  assert.equal(text('ls-tree', automationSha, '--', '.github/dependabot.yml'), '')
  const original = text('ls-tree', INITIAL_MAIN, '--', '.github/dependabot.yml').split('\t')[0]
  const quarantined = text('ls-tree', automationSha, '--', '.github/upstream-dependabot.yml.disabled').split('\t')[0]
  assert.equal(quarantined, original, 'D must preserve the original Dependabot blob and file mode')
  assert.deepEqual(text('diff', '--no-renames', '--name-only', automationSha, controlSha).split('\n').sort(), controlFiles)
  const patch = git('diff', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff',
    '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', controlSha, sessionSha)
  assert.equal(createHash('sha256').update(patch).digest('hex'), CANONICAL_PATCH_SHA256,
    `S must contain exactly the original ${CANONICAL_PRODUCT} product patch, without fixups or extra files`)
  const workspacePatch = git('diff', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff',
    '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', sessionSha, productSha)
  assert.equal(createHash('sha256').update(workspacePatch).digest('hex'), WORKSPACE_PATCH_SHA256,
    `W must contain exactly the reviewed ${CANONICAL_WORKSPACE} workspace patch`)
  git('diff', '--check', controlSha, productSha)
  return { automationSha, controlSha, sessionSha, productSha }
}

if (import.meta.main) console.log('Verified exact integration graph:', verifyProductGraph(resolve(process.argv[2])))
