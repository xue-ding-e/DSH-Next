---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-queued-message-recall

English | [中文](2026-10-27-queued-message-recall.zh.md)

## Summary

Adds optional recall request identity and removed user content to the existing agent/inbox/spliced event for interrupted queue-to-composer handoff recovery.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-queued-message-recall
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "4ee9d5bde7cfa90e7c66e9245a3fff014f9535baaf90fa2b7d2e8661f007309b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events without recall remain valid and the recovery projection ignores them. Existing readers apply the unchanged canceled splice and do not use the optional metadata, so removal is retained and content is not requeued. New recovery is restricted to committed own-Session operations, excluding inherited fork events. Older clients do not gain recall recovery support; this is not a general downgrade guarantee.

<a id="verification"></a>
## Verification

Source inspection of both inbox readers and the recovery projection; 90 bounded adapted tests passed locally, including JSON Session replay and response-loss recovery. CI run 40591419528 generated the schema and classified this sole change as optional-property-added with requiresCompatibilityReview false; 620 types unchanged. Full locked-toolchain behavior, disk persistence, SDK and native UI validation remain pending.

<a id="dev-note"></a>
## Dev Note

None.
