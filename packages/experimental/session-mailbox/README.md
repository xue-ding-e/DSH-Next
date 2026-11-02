# Queue-only session mailbox candidate

English | [中文](README.zh.md)

Internal implementation candidate, not a registered plugin or an enabled cross-session product feature. `SessionMailbox` uses the existing storage-domain service and its JSON backend; one authoritative record supplies both inbox and outbox without a cross-Session transaction. The Host must own the storage root exclusively.

## Admission and delivery

The Host resolves an opaque caller capability into an explicit principal, canonical principal key, and source Session. Tool-provided identity fields and an absent invocation never imply owner authority. Admission, reads, cancellation and acknowledgement consult the current injected policy. The policy owns source-send, recipient-receive, workspace/account and lifecycle restrictions. There is no unrestricted history lookup or authority transfer. Self-delivery is refused.

`send` stores only text supplied by its caller and marks it `untrusted-agent-content`. The only delivery mode is `queue-only`; there is no Agent dependency, wake option, restoration, forwarding, automatic response or model-visible injection. `ack` acknowledges mailbox receipt, not a completed Agent turn. Only the recipient can acknowledge; only the original sender Session and principal can cancel. Cancel and ack serialize and only one terminal transition wins.

The retry key is scoped to the Host-canonical principal and sender Session. A retry that still passes current authorization and target-receive admission returns the original receipt, including terminal status; changing its target or text conflicts. Terminal records remain as deduplication tombstones. Limits bound retained record count and complete UTF-8 record size, including the longest terminal status. Returned records are isolated snapshots. An aborted signal prevents admission; cancellation after durable write begins does not retract acceptance.

Authorization is checked at serialized admission before a durable write begins. Revocation during that write does not cancel or alter the accepted message or acknowledgement; resolved identity and request values are already captured. Subsequent retries, reads and acknowledgements use current permissions. An integrating Remote adapter that requires response-time authorization must recheck after the write and hide a now-forbidden response without rolling back committed state. Uncommitted records are not visible to list readers.

Writes use storage-domain serialization and storage-json atomic replacement, not a new file lock. Any write failure quarantines the service because rename may have succeeded before acknowledgement failed. Close and reopen revalidate media before retry. Truncated authoritative media fails closed rather than resetting receipts. This provides durable retry reconciliation, not exactly-once execution.

## Model Experience

No prompt, tool, model request, token cost or KV-cache effect: this candidate does not expose mailbox content to a model. Future input delivery must log a dedicated source-attributed Session event before model visibility.

## Known Limitations and Deferred Work

- Single Host writer only. The JSON backend does not enforce cross-process leases; a second process can overwrite records. Multiple independent facilities over the same root are unsupported. No multi-process safety claim is made.
- No Remote endpoint, model tool, Loader registration, UI, production permission adapter, dispatch integration, or shipped bundle. This is not release-ready.
- No trigger-turn operation. A future separately authorized dispatcher must recheck target permissions and lifecycle at activation, require explicit user authorization, maintain a durable activation receipt, and cap route depth and activation budget. Queue acceptance alone must never authorize execution.
- Original text only; no attachments, source transcript capture or forwarding. Automatic agent-to-agent forwarding is absent, so it cannot form an automatic wake loop. Manual repeated sends remain subject to policy and quota.
- Records retain sender principal key and terminal result, but this candidate has no append-only denial/transition audit stream, timestamp, expiry or retention compactor. Deleting terminal records would invalidate the current retry guarantee.
- Cold/archived/deleted/one-shot Session decisions are delegated to the trusted Host policy. No Session is materialized by the service.
- Tests exercise the real JSON backend, restart, concurrent same-process sends, cancel/ack races, forged capabilities, revoked permissions, bounds, truncated media and post-publish acknowledgement loss. They do not simulate OS process death or power loss and do not establish cross-process exclusion.

## Source comparison

Existing adjacent-agent messaging lives in `packages/subagent/subagent/src/manager.ts` (`sendMessage`, `submitAdmitted`): the latter wakes the target after both steer and queue delivery. Existing team peer messaging in `packages/experimental/agent-team/src/index.ts` (`sendAdmitted`) relays through the team root and likewise steers a live Agent. Neither is queue-only mail to an independent Session. `packages/typert/protocol/src/principal.ts` deliberately maps owner and absent invocation to undefined; this candidate must not use that normalization as model-tool authorization.
