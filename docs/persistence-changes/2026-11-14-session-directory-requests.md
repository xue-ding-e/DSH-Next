---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-session-directory-requests

English | [中文](2026-11-14-session-directory-requests.zh.md)

## Summary

Records the directory selections of a Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-session-directory-requests
baseline: false
changes:
  - root: "event:sandbox/roots-requested"
    previous: null
    after: "fa8800e5c6dcf0bdb48dc544297cb31de6d1093472f31c8fccc1a5a95afa88ce"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Current readers accept existing logs without the event. Older readers reject the required event. Replay restores the selection and leaves write policy unchanged.

<a id="verification"></a>
## Verification

Focused tests passed for pre-publication capture, blank Session reuse, durable JSONL restore, old-reader refusal, and fork-prefix recovery.

<a id="dev-note"></a>
## Dev Note

None.
