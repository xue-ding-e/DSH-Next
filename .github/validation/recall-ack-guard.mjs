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
export function assertRecallClassification(review, check) {
  assert.equal(review.schemaVersion, 1)
  assert.equal(review.roots.length, 1)
  const root = review.roots[0]
  assert.equal(root.root, ROOT)
  assert.equal(root.before, BEFORE)
  assert.equal(root.after, AFTER)
  assert.equal(root.changes.length, 1)
  const expected = { root: ROOT, path: `${ROOT}.data.recall`, kind: 'optional-property-added', description: 'optional property added', requiresCompatibilityReview: false }
  assert.deepEqual(root.changes[0], { path: expected.path, kind: expected.kind, description: expected.description, requiresCompatibilityReview: false })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'unacknowledged-changes')
  assert.deepEqual(check.changes, [expected])
  assert.deepEqual(check.roots, [{ root: ROOT, kind: 'event', before: BEFORE, after: AFTER }])
  assert.deepEqual(check.files, [])
}
export function assertRecordFiles(paths) {
  assert.deepEqual([...paths].sort(), [...RECORD_FILES].sort(), 'only the four reviewed acknowledgement files may be new')
}
