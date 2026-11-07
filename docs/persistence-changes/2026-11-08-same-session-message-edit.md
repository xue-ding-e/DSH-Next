---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-same-session-message-edit

English | [中文](2026-11-08-same-session-message-edit.zh.md)

## Summary

Add optional conversation replacement metadata so editing the latest user message reruns in the original Session while preserving the append-only raw log.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-same-session-message-edit
baseline: false
changes:
  - root: "SessionEventEnvelope"
    previous: "2026-09-11-initial"
    after: "ba24dfe93525adbef59f132ce5887b6218de7d3501733db6587ce860b8fe75de"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-queued-message-recall"
    after: "26c9f70daf6badfc7c710b94d301cf692ee6d36d70f4e49d55d71b5e440045c0"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "6a9b7750e3320c9747f887bc4d0d72c18b53533892dd6a3d91b7b3b0dc39e0ca"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "e79b178720c174bb2ff94f77ce07df94202eea9a6606565472c91bcb2491946c"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "1f3f044e7b79fff644ca9bafae110e2247e7568dbde4bb974068d1fbd382f588"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "6091de7d58c70517b5d69c03bebf2f7c520c6756b74d060b7f09a0863f2bc2b3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "fbadfec353103130a829f7efc3e8dc2c97b8e6a97c1ba3abef10934eb297d94d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events without conversationOp or inbox admissions remain valid and keep their current behavior. New readers apply conversationOp only to an admitted replacement user message and retain the hidden raw range for audit and replay; missing metadata means ordinary append behavior. Older readers reject the new envelope field before execution or tail repair rather than interpreting the replacement as ordinary history. The Session format remains version 4 because the existing envelope admission prevents unsafe execution, and feature-free Sessions remain readable.

<a id="verification"></a>
## Verification

Focused Host edit, Session surface, AgentLoop inbox, Chat, Liveshare endpoint, and browser edit tests pass. Build artifacts and the Web edit flows pass, including refresh and file attachment cases. Persistence catalog generation and schema checks pass; the compatibility decision is recorded by this change record.

<a id="dev-note"></a>
## Dev Note

None.
