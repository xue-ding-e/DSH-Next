---
kind: upgrade-guide
description: "Custom question interfaces must provide Workspace navigation for desktop notification activation."
---

# Desktop question notifications

English | [中文](guide.zh.md)

## Change

The Client plugin from `@deepseek-ai/dsh-client-ui-user-questions` requires `uiWorkspace`. Custom Client compositions must provide this navigation service so a system notification can open its question's Session. The shipped Web and Desktop compositions already provide it.

Desktop notifications use the `dshDesktop.questionNotifications` preload capability. Their device preference defaults to enabled. Ordinary Web clients show questions in the conversation without registering a notification setting or an attention reminder card.

## Migration

1. Include [`@deepseek-ai/dsh-client-ui-workspace`](../../../../packages/client/ui-workspace/README.md) and its documented dependencies in custom compositions that load the question interface.
2. Update the desktop shell, preload, and question interface together. A desktop carrier without the notification capability reports a delivery failure while the question remains answerable.
3. Trigger a question with the desktop window minimized and verify that clicking its system notification restores the window, opens the source Session, and reveals the question. Verify that disabling question notifications persists after reload.
