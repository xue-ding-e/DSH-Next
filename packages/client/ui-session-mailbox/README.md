---
description: "Send a message to another session and open its inbox."
kind: "package-reference"
---

# Session mailbox UI

English | [中文](README.zh.md)

## Summary

Send a message to another session and open its inbox.

## Table of Contents

- [Explicit interaction](#mailbox-usage)
- [Limits](#mailbox-implementation)

This reference describes the Web conversation-header mailbox action. It mounts the generated [mailbox Remote contribution](../../api/session-mailbox-controller/README.md), uses the existing current-Host Session catalog, and displays untrusted messages as text nodes in the shared modal primitive.

<a id="mailbox-usage"></a>
## Explicit interaction

Choose a destination and enter text, then confirm queue-only sending. Neither sending nor reading starts an Agent. Running destinations are not interrupted. Opening the panel does not read an inbox; the user explicitly requests the current Session's inbox and separately acknowledges a displayed receipt. Archive, deletion and permission decisions remain Host checks rather than UI-only filters.

One UI action obtains a short-lived exact-route grant, prepares one immutable operation, consumes it and releases the grant. Closing the modal, changing the selected Session or resetting the connection aborts the interaction; a grant reply arriving after cancellation is also revoked. Repeated clicks do not create concurrent submissions. Revocation and closing do not retract messages that already committed.

Before contacting the Host for a send, the UI stores its source, destination, request id and entered text in the tab's `sessionStorage`, scoped to the endpoint's origin/path and the freshly fetched logical mailbox realm and single-owner domain. Query strings, fragments, URL credentials and authentication tokens are excluded from the key. This is bounded retry state, not a stored capability. An unknown outcome restores the same draft and request identity when the panel reopens or the tab reloads; it must be reconciled unchanged before being replaced. Successful reconciliation removes it when storage remains writable; otherwise the UI confirms delivery and reports that retry state is retained. Storage denial or quota failure blocks a new send rather than sending without a recoverable identity. Each partition has at most 32 pending drafts and each body is bounded to 16 KiB UTF-8. Opening after a connection reset fetches identity again; a stale panel cannot grant a route on a different realm. Identity failure opens no draft, and restoring a draft never prepares or sends it automatically. Other tabs and a new browser session do not share this recovery store; after its loss, inspect the recipient inbox rather than assuming a failed reply means no delivery.

<a id="mailbox-implementation"></a>
## Browser ownership

The browser credential represents the account owner; tabs are not separate authorization principals, and the UI cannot cryptographically prove a physical click. The Host accepts only its actual browser Peer, not an API operator or a model-supplied owner string. Pending text remains in this tab's browser storage until reconciliation or browser-session removal. UI selection cancellation is not cancellation of a persisted mailbox receipt.

The Web bundle mounts this UI and its controller. Model-facing route-granted communication, automatic dispatch, attachments, outbox management and trigger-turn execution are outside this UI. Component tests cover explicit selection, plain-text rendering, cancellation, repeated clicks and persisted retry identity; generated Gateway and private-storage lifecycle tests belong to the controller.

New blank drafts are rejected before storage or any grant. An old invalid pending draft remains available for unchanged same-id reconciliation. Only an authoritative `not-accepted` response releases it for editing; generic failure keeps it read-only. Complete escaped-JSON limits are enforced by the Host against its current configured budget, not guessed from raw text length in the browser.

<a id="model-experience"></a>
## Model Experience

None, as queued mailbox text is shown only to the user.

#### KV Cache effect

Mailbox operations leave the model cache unchanged.

## Known Limitations and Deferred Work

- Only the owner browser in the same profile can deliver text and explicitly read messages. Delivery never starts a Session.

<a id="dev-note"></a>
### Dev Note

None.
