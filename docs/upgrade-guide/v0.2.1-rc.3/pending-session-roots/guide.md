---
kind: upgrade-guide
description: Older readers reject Session logs containing the required directory-request snapshot event.
---

# Session directory-request snapshots

English | [中文](guide.zh.md)

## Change

New Workspace Sessions with non-empty additional-directory defaults record the required `sandbox/roots-requested` event. Older readers that do not recognize this event reject those logs instead of dropping directory selections. Existing logs without the event remain readable. The event stores pending requests, not execution authorization; restoring or importing it grants no additional write access.

## Migration

1. Upgrade every DSH reader used to resume, fork, or import these Sessions to a version that recognizes `sandbox/roots-requested` before sharing new logs with it.
2. Keep the event intact. Do not delete it or mark it ignorable to make an older reader accept the log.
3. Reopen a Session containing the event with the upgraded reader and confirm its pending selections are restored while its primary cwd remains unchanged. Directory activation and selection UI are not supplied by this change.

See the [persistence compatibility record](../../../persistence-changes/2026-11-01-pending-session-roots.md).
