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
    previous: "2026-10-27-retry-control-input"
    after: "58e19083c1e104320107ca3b3e73543e39c060a402adf746d72f10691529a9ea"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing splice events without recall remain valid. Readers that do not consume the optional recall metadata still apply the unchanged cancellation and do not requeue removed input. Recovery reads committed own-Session operations and excludes inherited fork events. The combined event retains the upstream skill-catalog incomplete discriminator; this optional field does not change splice behavior. Older clients do not gain recall recovery support or general downgrade support.

<a id="verification"></a>
## Verification

The combined source passes 142 prompt-admission and bundle-purity checks and 62 queue-recall and Liveshare tests. The recall transaction cases cover committed response-loss recovery and write ownership. Generated schema validation and the complete build are checked separately; native desktop behavior is not established by these unit tests.

<a id="dev-note"></a>
## Dev Note

None.
