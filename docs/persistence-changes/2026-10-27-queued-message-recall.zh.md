---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-queued-message-recall

[English](2026-10-27-queued-message-recall.md) | 中文

## 概述

为现有 agent/inbox/spliced 事件添加可选的召回请求身份和被移除的用户内容，用于恢复被中断的队列到输入框交接。

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
    previous: "2026-10-27-retry-control-input"
    after: "58e19083c1e104320107ca3b3e73543e39c060a402adf746d72f10691529a9ea"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有 recall 的已有 splice 事件仍然有效。不消费可选召回元数据的读取方仍按原有取消语义处理，不会重新排入已移除的输入。恢复仅读取当前会话已提交的操作，并排除分支继承的事件。组合后的事件保留上游 skill-catalog 的 incomplete 判别字段；该可选字段不改变 splice 行为。旧客户端不会因此获得召回恢复能力，也不获得一般降级支持。

<a id="verification"></a>
## 验证

组合后的源码通过 142 项提示词准入和打包纯度检查，以及 62 项队列召回和 Liveshare 测试。召回事务用例覆盖已提交操作的回复丢失恢复和写入所有权。生成类型验证和完整构建另行检查；这些单元测试不构成原生桌面行为的证明。

<a id="dev-note"></a>
## 开发备注

无。
