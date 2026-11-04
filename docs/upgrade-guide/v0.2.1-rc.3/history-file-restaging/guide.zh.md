---
kind: upgrade-guide
description: "自定义文件上传组合必须提供 Session Query，以重新暂存历史文件。"
---

# 历史文件重新暂存

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-file-upload` 的 Host 服务除已有依赖外，还要求提供 `sessionQuery`。挂载了文件上传但未挂载 Session Query 的自定义 Cordis 组合必须补充该服务。随产品提供的 Web 和 Desktop 组合已包含此服务。

Chat 使用 `fileUploads.stageHistory`，在编辑并重新发送历史用户消息时保留普通文件附件。该方法要求同时拥有来源 Session 和接收 Session 的访问权限，校验准确的消息及内容位置，并生成归接收方所有的凭据。已有上传方法和待发送文件读取权限的语义保持不变。

## 迁移

1. 按照依赖说明，在提供文件上传的 Host 上下文中挂载 [`@deepseek-ai/dsh-session-query`](../../../../packages/session-query/session-query/README.zh.md)。文件上传包及其使用方须使用同一发行版本。
2. 使用自定义 Remote 访问策略时，仅在来源和接收方的 Session 资源均获授权后允许 `fileUploads.stageHistory`。已有原始文件上传权限本身不授予历史文件复用权限。
3. 加载自定义 profile，确认 `fileUploads` 已就绪。编辑一条带文件的历史用户消息，选择**保存并发送**，确认新分支包含修改后的文本和原附件，且来源历史保持不变。
