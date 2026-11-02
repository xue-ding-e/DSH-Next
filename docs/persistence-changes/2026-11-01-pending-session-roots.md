---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-pending-session-roots

English | [中文](2026-11-01-pending-session-roots.zh.md)

## Summary

Adds a required sandbox/roots-requested event for creation-time pending directory snapshots. The sandbox policy service owns its bounded projection; API fresh-Session setup captures Workspace defaults before Agent publication.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-pending-session-roots
baseline: false
changes:
  - root: "event:sandbox/roots-requested"
    previous: null
    after: "fa8800e5c6dcf0bdb48dc544297cb31de6d1093472f31c8fccc1a5a95afa88ce"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers keep old logs valid with no pending roots. The event grants no execution permissions, including after import, restart or fork; the policy resolver remains unchanged. Older readers reject this unknown non-ignorable event before interpreting or mutating its log. The V4 admission regression exercises that refusal with the old event vocabulary; no header change or migration is needed.

<a id="verification"></a>
## Verification

Owner tests passed (27); existing Session controller tests passed (24); five real Agent lifecycle and JSONL restore tests passed with only the OS flock entry mocked because system.node is unavailable. Native cross-process lock validation and aggregate documentation checks remain unverified.

<a id="dev-note"></a>
## Dev Note

None.
