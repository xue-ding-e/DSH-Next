---
description: "Store independent session messages with bounded delivery and retry identity."
kind: "package-reference"
---

# Queue-only session mailbox

English | [中文](README.zh.md)

## Summary

Store independent session messages with bounded delivery and retry identity.

## Table of Contents

- [Admission and delivery](#mailbox-usage)
- [Internal Host adapter](#mailbox-implementation)

Internal durable library consumed by the [browser mailbox controller](../../api/session-mailbox-controller/README.md); this package itself registers no Remote or model tool. `SessionMailbox` uses the existing storage-domain service and its JSON backend; one authoritative record supplies both inbox and outbox without a cross-Session transaction. The Host must own the storage root exclusively.

<a id="mailbox-usage"></a>
## Admission and delivery

The Host resolves an opaque caller capability into an explicit principal, canonical principal key, and source Session. Tool-provided identity fields and an absent invocation never imply owner authority. Admission, reads, cancellation and acknowledgement consult the current injected policy. The policy owns source-send, recipient-receive, workspace/account and lifecycle restrictions. There is no unrestricted history lookup or authority transfer. Self-delivery is refused.

`send` stores only text supplied by its caller and marks it `untrusted-agent-content`. The only delivery mode is `queue-only`; there is no Agent dependency, wake option, restoration, forwarding, automatic response or model-visible injection. `ack` acknowledges mailbox receipt, not a completed Agent turn. Only the recipient can acknowledge; only the original sender Session and principal can cancel. Cancel and ack serialize and only one terminal transition wins.

The retry key is scoped to the Host-canonical principal and sender Session. A retry that still passes current authorization and target-receive admission returns the original receipt, including terminal status; changing its target or text conflicts. Terminal records remain as deduplication tombstones. Limits bound retained record count and complete UTF-8 record size, including the longest terminal status. Returned records are isolated snapshots. An aborted signal prevents admission; cancellation after durable write begins does not retract acceptance.

Authorization is checked at serialized admission before a durable write begins. Revocation during that write does not cancel or alter the accepted message or acknowledgement; resolved identity and request values are already captured. Subsequent retries, reads and acknowledgements use current permissions. An integrating Remote adapter that requires response-time authorization must recheck after the write and hide a now-forbidden response without rolling back committed state. Uncommitted records are not visible to list readers.

Writes use storage-domain serialization and storage-json atomic replacement, not a new file lock. Any write failure quarantines the service because rename may have succeeded before acknowledgement failed. Close and reopen revalidate media before retry. Truncated authoritative media fails closed rather than resetting receipts. This provides durable retry reconciliation, not exactly-once execution.

<a id="mailbox-implementation"></a>
## Internal Host adapter

The `/host` export is a programmatic helper, not an RPC endpoint. `withHostMailbox` owns a dedicated JSON backend and the complete mailbox lifetime. Its fixed `privateRoot` is chosen by trusted Host assembly, never a Remote parameter; POSIX ownership and private permissions are checked without changing existing permissions. The adapter uses the existing `withFileLock` before opening storage and releases it only after accepted operations, the domain and backend drain. It rejects a cooperating second instance for the same canonical root. Windows root ACL privacy remains an assembly precondition, not a claim made by this check.

Only trusted Host user-selection handlers may call the adapter's issuer. The opaque process-local capability binds the exact authenticated Peer instance, operation and selected Sessions; a send also captures its text and retry key. Execution requires a matching live `ctx.invocation.peer`. A selection is consumed exactly once when its queued operation claims it, including rejected or expired claims. Subsequent checks use an internal operation lease, which is disposed on every outcome; another call needs a fresh explicit selection. Missing invocation, forged owner fields, another connection and disposed Peers are refused. The first adapter accepts only the local owner. RemoteAccess is consulted for the exact `sessionMailbox/send`, `sessionMailbox/inbox` or `sessionMailbox/ack` action and affected Session resources, but RemoteAccess deliberately allows owner; the mandatory Host-issued selection is a separate restriction. No public issuer, model tool or Remote route is registered.

The Host must configure `selectionTtlMs` from 1 through 30,000 milliseconds. A monotonic deadline is checked before and after asynchronous boundaries, including the final lifecycle probe for an empty inbox. Issuance checks the issuing invocation signal, but the selection has a separate required `cancelSignal`: successful completion of the issuing RPC is not selection cancellation. Future UI handlers must explicitly cancel the selection on user cancellation. A later invocation on the same live Peer may claim it once before expiry; concurrent and sequential replays are refused. An already-started durable write is not rolled back when its lease expires or is cancelled. If that write was accepted but its result can no longer be disclosed, the adapter returns `outcome-unavailable` without message content, not a claim that nothing was sent. Reconciliation requires a fresh authorized selection with the same sender, target, text and request id; durable deduplication returns the existing receipt.

The adapter reads SessionStore headers or `sessionPersistence.stat`, never history or `resolveAgent`. Cold ordinary Sessions can receive without restoration; a running ordinary Session receives the same queue-only record without steering or interruption. Unknown, archived, subagent-origin and migration-required Sessions are refused. Inbox and acknowledgement require a current valid target; replies are checked again after durable writes. Archive or deletion can hide a response without undoing an accepted record. Lifecycle probes and mailbox persistence are not one atomic transaction: deletion after the existence snapshot can leave an orphaned receipt, but no Agent activation results. Reusing a deleted Session id is outside the supported lifecycle.

The file lock is cooperative, same-host and same-PID-namespace only. It probes recorded PIDs, takes over only a proven exited holder under a rechecked takeover claim, and does not expire a live holder. It does not protect against an external actor replacing a live lock; final release removes its pathname without inode/nonce verification. Incomplete lock records and stranded takeover claims can fail closed and require operator inspection. Shared-host storage, hostile replacement and bypassing the helper are not supported. This adapter does not upgrade the underlying storage backend to a general multi-process transaction service.

## Model Experience

None, as queued mailbox text is shown only to the user.

#### KV Cache effect

Mailbox operations leave the model cache unchanged.

## Known Limitations and Deferred Work

- The raw `SessionMailbox` still requires a single Host writer. Its JSON backend does not enforce cross-process leases; a second process can overwrite records. Multiple independent facilities over the same root are unsupported. No multi-process safety claim is made.
- Browser Remote and UI composition are owned by the separate controller and UI packages. Model tools and dispatch integration are absent.
- No trigger-turn operation. A future separately authorized dispatcher must recheck target permissions and lifecycle at activation, require explicit user authorization, maintain a durable activation receipt, and cap route depth and activation budget. Queue acceptance alone must never authorize execution.
- Original text only; no attachments, source transcript capture or forwarding. Automatic agent-to-agent forwarding is absent, so it cannot form an automatic wake loop. Manual repeated sends remain subject to policy and quota.
- Records retain sender principal key and terminal result, but this library has no append-only denial/transition audit stream, timestamp, expiry or retention compactor. Deleting terminal records would invalidate the current retry guarantee.
- The raw service delegates lifecycle decisions to Host policy; the internal adapter implements the conservative header-only policy above. No Session is materialized by either.
- Tests exercise real JSON persistence, RemoteAccess, Peer, SessionStore and WorkspaceRegistry, with a controlled metadata-only persistence substitute for cold-session races. They also cover deferred visibility, explicit-selection binding, archive/delete response races, one-time claims, same-Peer later invocations, independent cancellation, monotonic expiry during a real file publish, empty-inbox final-probe cancellation and cooperative duplicate-instance refusal. The base tests exercise the real JSON backend, restart, concurrent same-process sends, cancel/ack races, forged capabilities, revoked permissions, bounds, truncated media and post-publish acknowledgement loss. They do not simulate OS process death or power loss and do not establish cross-process exclusion.

<a id="dev-note"></a>
### Dev Note

None.
