import assert from 'node:assert/strict'
export const ROOT = 'event:agent/inbox/spliced'
export const BEFORE = 'b36fd842cd004b532ce96fd5d6f5be28e017eda043131aa3cf5e69edc436108e'
export const AFTER = '4ee9d5bde7cfa90e7c66e9245a3fff014f9535baaf90fa2b7d2e8661f007309b'
export const RECORD = '2026-10-27-queued-message-recall'
export const RECORD_FILES = ['md', 'zh.md', 'i18n.yaml', 'schema.json'].map(ext => `docs/persistence-changes/${RECORD}.${ext}`)
export const DOC_PAIRS = ['docs/architecture.md', 'packages/client/file-upload/README.md', 'packages/client/ui-conversation/README.md', 'packages/api/session-controller/README.md']
export const LINK_ADDITIONS = ["  QueueRecallResolver: 'attachment.md',", "  RecalledFileStaging: 'attachment.md',", "  Branded: 'core.md',", "  AttachmentId: 'attachment.md',"]
export function assertReviewedToolChanges(changed, before, after) {
  assert.deepEqual(changed, ['scripts/gen-cordis-catalog.ts'])
  let restored = after
  for (const line of LINK_ADDITIONS) {
    assert.equal(restored.split(line).length, 2, 'each reviewed link must occur once')
    restored = restored.replace(line + '\n', '')
  }
  assert.equal(restored, before, 'only four reviewed ownership links may differ')
}
export function assertReviewedRecallTransition(review) {
  assert.equal(review.schemaVersion, 1)
  assert.equal(review.roots.length, 1)
  const root = review.roots[0]
  assert.equal(root.root, ROOT)
  assert.equal(root.before, BEFORE)
  assert.equal(root.after, AFTER)
  assert.equal(root.changes.length, 1)
  const expected = { root: ROOT, path: `${ROOT}.data.recall`, kind: 'optional-property-added', description: 'optional property added', requiresCompatibilityReview: false }
  assert.deepEqual(root.changes[0], { path: expected.path, kind: expected.kind, description: expected.description, requiresCompatibilityReview: false })
}
export function assertRecallClassification(review, check) {
  assertReviewedRecallTransition(review)
  const expected = { root: ROOT, path: `${ROOT}.data.recall`, kind: 'optional-property-added', description: 'optional property added', requiresCompatibilityReview: false }
  assert.equal(check.ok, false)
  assert.equal(check.code, 'unacknowledged-changes')
  assert.deepEqual(check.changes, [expected])
  assert.deepEqual(check.roots, [{ root: ROOT, kind: 'event', before: BEFORE, after: AFTER }])
  assert.deepEqual(check.files, [])
}
export function assertRecordFiles(paths) {
  assert.deepEqual([...paths].sort(), [...RECORD_FILES].sort(), 'only the four reviewed acknowledgement files may be new')
}

export const ACCEPTED_RECORD_HASHES = {
  "docs/persistence-changes/2026-10-27-queued-message-recall.i18n.yaml": "33b4063330fc6534cb61598e306f986c1eba50ad8c53591d1d3129f32ce403b2",
  "docs/persistence-changes/2026-10-27-queued-message-recall.md": "3e76d42cc32974f7cb381479a3438317d2d6c936871bec6b875fc0e2fb395330",
  "docs/persistence-changes/2026-10-27-queued-message-recall.schema.json": "2d5da3d56f2af1d6e9c5939c3dc132cc30e56e62dfb7222132467d883045c6b5",
  "docs/persistence-changes/2026-10-27-queued-message-recall.zh.md": "81113e0a7dfed7d509cf3cb28fa8afbc52aa4fe0e430b5fa61e7d606c4c0a308"
}
export function assertAcceptedRecord(review, check, hashes) {
  assertReviewedRecallTransition(review)
  assert.equal(check.schemaVersion, 1)
  assert.equal(check.operation, 'check')
  assert.equal(check.ok, true, 'existing reviewed acknowledgement must verify before proceeding')
  assert.deepEqual(check.changes, [])
  assert.deepEqual(check.roots, [])
  assert.deepEqual(check.files, [])
  assert.deepEqual(hashes, ACCEPTED_RECORD_HASHES, 'accepted record bytes changed; new review required')
}
