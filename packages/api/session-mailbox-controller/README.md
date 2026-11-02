# Session mailbox controller

English | [中文](README.zh.md)

This reference covers the browser-authorized, queue-only Remote controller mounted by the Web bundle. It owns route grants and selection handles; [the mailbox library](../../experimental/session-mailbox/README.md) owns durable records and cooperative private-root locking. The profile fixes the root at `profileContext.dir + '/session-mailbox'`; a Remote caller cannot select a storage path.

## Authority and operations

Every method requires an invocation whose Peer is the exact `connection.browserPeer` captured during Host construction. An owner principal, `interactions: answer`, a claimed identity, or an API operator is insufficient. Browser authentication does not prove a physical click: authenticated browser tabs share one Peer and are not separate security principals. The UI makes the authorization explicit; callers with that browser authority remain the account owner.

`identity` returns a non-secret logical mailbox realm and the supported `single-owner` domain. It is not an authentication credential or a hardware Host identity. `grant` requires that expected identity still match and authorizes one selected source/target send route, or one target inbox/ack route, for at most 30 seconds. `prepare` freezes one operation on that route and returns a random opaque handle. `execute` consumes the handle before awaiting and performs the operation through the internal adapter. `revoke` cancels all selections on a route, including active leases. Nothing invokes an Agent, injects a prompt, or turns a reference into an instruction.

The Host retains at most 32 grants and 64 unclaimed selections. A message body is bounded to 16 KiB UTF-8. Grant and selection expiry share the monotonic platform clock; the grant deadline can only shorten the selection lifetime. Timers reclaim resources but do not establish authorization validity. Current permission and lifecycle checks remain mandatory at execution and before returning content. The response projects only message id, source, target, text, status, trust and delivery mode, not storage principal keys.

Closing the controller cancels grants before draining and closing the owned mailbox. A mutation committed before revocation or expiry is not rolled back; its result may be unavailable. A fresh authorized selection with the same send request id, or the same acknowledgement receipt id, reconciles the operation. Unknown, archived, subagent and migration-required targets remain refused; a running ordinary target receives a record without interruption.

The separate `session_mailbox_identity` domain is version 1 and has one `owner` row containing a UUID. It initializes under the same private-root lock, commits before publishing the adapter, and fails closed on unreadable or invalid state. Existing message records are not rewritten when this metadata is added. Reopening preserves the realm; a different root creates a different realm. Copying or restoring the identity file preserves the logical realm, not a hardware identity; removing it creates a new partition. No multi-owner login identity exists in this Host authority model.

## Verification and limits

Generated-contract integration tests require the repository's source-only Typert generation first. They use real Gateway, Connection, RemoteAccess and JSON persistence against an explicit temporary `DSH_HOME`; no real user Session or credential is used. Artifact-dependent cases follow the repository convention of skipping when generated artifacts are absent; their execution, not a skip, is required for accepting this controller.

The browser entry is [the session mailbox UI](../../client/ui-session-mailbox/README.md). Model-facing send/read tools, actual Agent-bound route grants, durable audit events, multi-Host storage and trigger-turn delivery are not implemented here. Agent tools must later bind the actual executing Agent and Session to user-granted destinations rather than borrowing browser-owner authority. Translation sidecars and the complete repository checks remain required before release.

The launcher owns `profileContext.dir`; separate Web and Desktop profiles under the same DSH home therefore use separate private roots and logical realms. Without a launcher profile this default entry is disabled; trusted custom assembly must provide an explicit private root. Existing global candidate mailboxes are not automatically migrated or merged. Two processes opening the same profile root still conflict. The entry is not in app-boot's required startup set: lock/open failures leave the mailbox unavailable with an activation warning, not a fallback unlocked store or a mandatory whole-app failure.

A send returns `outcome: not-accepted` only for the dedicated durable-service refusal after current authorization and same-identity lookup proved there is no record, before any write (invalid text or configured capacity/complete serialized-record limit). JSON escaping and the terminal status are included in the actual UTF-8 byte budget; the raw text limit is not a promise that the record fits. Preparation, generic denial, conflicts, cancellation and unknown storage/network outcomes do not prove non-delivery. The UI may release a retry draft only on this explicit result or a successful receipt.
