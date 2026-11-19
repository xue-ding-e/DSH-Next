---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

English | [中文](2026-11-05-timeline-priority-notice.zh.md)

## Summary

Records a Timeline notice when the user adds or removes urgent priority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-timeline-priority-notice
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-08-same-session-message-edit"
    after: "2d53d51342b974714017e795f55449cb15ccfb4078ed3139eed8d91949bf6c53"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-08-same-session-message-edit"
    after: "980d8d94d33535da78d462a086c11381444180860358de077a128a58287515f4"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "4ee17e4219bd5fab6148ec0a8b3ec0fb939edb8f211374cf779bc8135ef9bed2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-08-same-session-message-edit"
    after: "92b7a8e68375cda40fb5209d5a174d13ddaa38446fa6eeaea792f4b0a755e80d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages keep their source and meaning. Timeline notices carry ordinary text and a source label. Readers without Timeline can keep the unknown source and read the text without applying a task update. Timeline stores task trees, reports, and discussions in the session log as ignorable `plugin:timeline/*` records. Readers without Timeline skip these records.

<a id="verification"></a>
## Verification

Timeline's priority tests check that only user edits to urgent priority enqueue a notice. The process recovery test checks that Timeline state survives an interrupted writer.

<a id="dev-note"></a>
## Dev Note

None.
