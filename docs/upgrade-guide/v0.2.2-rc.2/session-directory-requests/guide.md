---
kind: upgrade-guide
description: Older readers refuse Session logs containing a directory selection.
---

# Session directory selections

English | [中文](guide.zh.md)

## Change

New Sessions with additional directory defaults record a required `sandbox/roots-requested` event. A reader must recognize the event to load those logs. Existing logs remain readable. The event restores directory selections and carries no execution grants.

## Migration

1. Upgrade each DSH installation that reads, imports, or forks these Sessions before sharing new logs with it.
2. Reopen the Session in the upgraded installation. Its saved selection and original working directory are recovered from the log.

See the [persistence acknowledgement](../../../persistence-changes/2026-11-14-session-directory-requests.md).
