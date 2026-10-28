---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-queued-message-recall

[English](2026-10-27-queued-message-recall.md) | 中文

## 概述

在现有 agent/inbox/spliced 事件中增加可选的撤回请求身份和被移除用户内容，用于恢复中断的队列到输入框交付。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-queued-message-recall
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "4ee9d5bde7cfa90e7c66e9245a3fff014f9535baaf90fa2b7d2e8661f007309b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含 recall 的已有事件仍然有效，恢复投影忽略这些事件。已有读取方按未改变的 canceled splice 执行移除，不使用可选元数据，因此保留移除结果且不会重新入队。新的恢复只处理本 Session 所有的已提交操作，排除分叉继承事件。旧客户端不会获得撤回恢复能力；这并非通用降级保证。

<a id="verification"></a>
## 验证

已检查双向 inbox 读取和恢复投影源码；本地 90 项有界适配测试通过，包括 JSON Session 回放及响应丢失恢复。CI 运行 40591419528 生成了 schema，将唯一变化判定为 optional-property-added、requiresCompatibilityReview false；620 个类型未变。完整锁定工具链行为、磁盘持久化、SDK 和原生 UI 验证仍待完成。

<a id="dev-note"></a>
## 开发备注

无。
