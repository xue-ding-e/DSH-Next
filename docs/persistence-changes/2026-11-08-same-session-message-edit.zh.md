---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-same-session-message-edit

[English](2026-11-08-same-session-message-edit.md) | 中文

## 概述

增加可选的会话替换元数据，使编辑最新用户消息时仍在原 Session 中重跑，同时保留只追加的原始日志。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-same-session-message-edit
baseline: false
changes:
  - root: "SessionEventEnvelope"
    previous: "2026-09-11-initial"
    after: "ba24dfe93525adbef59f132ce5887b6218de7d3501733db6587ce860b8fe75de"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-queued-message-recall"
    after: "26c9f70daf6badfc7c710b94d301cf692ee6d36d70f4e49d55d71b5e440045c0"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "6a9b7750e3320c9747f887bc4d0d72c18b53533892dd6a3d91b7b3b0dc39e0ca"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "e79b178720c174bb2ff94f77ce07df94202eea9a6606565472c91bcb2491946c"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "1f3f044e7b79fff644ca9bafae110e2247e7568dbde4bb974068d1fbd382f588"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "6091de7d58c70517b5d69c03bebf2f7c520c6756b74d060b7f09a0863f2bc2b3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "fbadfec353103130a829f7efc3e8dc2c97b8e6a97c1ba3abef10934eb297d94d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不带 conversationOp 或 inbox admission 的既有事件仍然有效并保持原有行为。新读取器只对已获准的替换 user 消息应用 conversationOp，并为审计和回放保留被隐藏的原始范围；缺少元数据时仍按普通追加处理。旧读取器会在执行或修复日志尾部前拒绝新的信封字段，不会把替换误读成普通历史。Session 格式保持版本 4，因为现有信封准入可以阻止不安全执行，不包含该功能的 Session 仍可读取。

<a id="verification"></a>
## 验证

Host 编辑、Session surface、AgentLoop inbox、Chat、Liveshare endpoint 以及浏览器编辑聚焦测试均通过。构建产物和 Web 编辑流程通过，并覆盖刷新及文件附件场景。持久化目录生成和 schema 检查通过；兼容性决定由本变更记录保存。

<a id="dev-note"></a>
## 开发备注

无。
