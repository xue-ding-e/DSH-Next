---
kind: upgrade-guide
description: "Custom file-upload compositions must provide Session Query for historical file restaging."
---

# Historical file restaging

English | [中文](guide.zh.md)

## Change

The Host service from `@deepseek-ai/dsh-client-file-upload` requires `sessionQuery` in addition to its existing dependencies. Custom Cordis compositions that mount file uploads without Session Query must provide it. The shipped Web and Desktop compositions already include this service.

Chat uses `fileUploads.stageHistory` to preserve ordinary file attachments when editing and resending a historical human message. The method requires access to both the source Session and the receiving Session, verifies the exact message and content position, and creates a receipt owned by the receiver. Existing upload methods and pending-file read authorization keep their semantics.

## Migration

1. Mount [`@deepseek-ai/dsh-session-query`](../../../../packages/session-query/session-query/README.md) in the Host context that provides file uploads, following its dependency instructions. Keep the file-upload package and its consumers on the same release.
2. For custom Remote access policies, permit `fileUploads.stageHistory` only when both the source and receiving Session resources are authorized. Existing raw upload permission alone does not authorize historical file reuse.
3. Load the custom profile and confirm that `fileUploads` is ready. Edit a historical human message containing a file, choose **Save and send**, and verify that the new branch contains the edited text and original attachment while the source history stays unchanged.
