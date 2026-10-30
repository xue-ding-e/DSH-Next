import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { manifest } from './qualification.mjs'

const workflow = readFileSync(new URL('../../workflows/next-context-menu-validation.yml', import.meta.url), 'utf8')
const runner = readFileSync(new URL('./qualification.mjs', import.meta.url), 'utf8')

test('Linux requalification binds the fixed product and a distinct read-only manual control branch', () => {
  assert.equal(manifest.source, '6b9ebe026a565e5aa547811972dff745961e134f')
  assert.equal(manifest.controlRef, 'refs/heads/validation/next-sidebar-linux-20261030')
  assert(workflow.includes('EXPECTED_PRODUCT_SHA: ' + manifest.source))
  assert(workflow.includes('ref: ' + manifest.source))
  assert(workflow.includes("github.ref == '" + manifest.controlRef + "'"))
  assert.match(workflow, /contents: read/u)
  assert.match(workflow, /workflow_dispatch:/u)
  assert.doesNotMatch(workflow, /contents: write|pull_request:|push:|windows-qualify|windows-installer|gh release/u)
  assert.match(workflow, /fetch-depth: 7/u)
})

test('Linux retains full qualification and adds the owned-protocol source regression', () => {
  assert.match(workflow, /qualification\.mjs linux product/u)
  for (const stage of ['desktop-tests', 'smoke-profile-tests', 'browser-cookie-tests', 'pointer-unit', 'full-build', 'doc-links', 'doc-pairing', 'chromium', 'pointer-browser', 'next-uninstall-regression']) {
    assert(runner.includes("'" + stage + "'"), stage)
  }
  assert(runner.includes('apps/desktop/tests/next-uninstall-protocol.test.mjs'))
  assert.match(runner, /tests: 3, pass: 3, fail: 0, skipped: 0, cancelled: 0/u)
  assert.match(workflow, /cancel-in-progress: false/u)
  assert.match(workflow, /timeout-minutes: 300/u)
  assert.match(workflow, /persist-credentials: false/u)
  assert.doesNotMatch(workflow, /continue-on-error/u)
})
