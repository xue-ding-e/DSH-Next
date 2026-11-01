---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-pending-session-roots

[English](2026-11-01-pending-session-roots.md) | 中文

## 概述

新增必读 sandbox/roots-requested 事件，记录创建时待确认目录快照。沙箱策略服务拥有有界投影；API 在新会话 Agent 发布前捕获 Workspace 默认目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-pending-session-roots
baseline: false
changes:
  - root: "event:sandbox/roots-requested"
    previous: null
    after: "fa8800e5c6dcf0bdb48dc544297cb31de6d1093472f31c8fccc1a5a95afa88ce"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取器继续接受旧日志，未记录事件时无待确认目录。事件不授予执行权限，导入、重启和分叉后也不例外；有效策略解析保持不变。旧读取器在解释或修改日志前拒绝这一未知且不可忽略的事件。V4 准入回归使用旧事件词表验证拒绝，不更改头部或引入迁移。

<a id="verification"></a>
## 验证

owner 测试 27 项、既有会话 controller 测试 24 项、新增真实 Agent 生命周期及 JSONL 恢复测试 5 项通过。因缺少 system.node，仅替换测试中的 OS flock 入口；原生跨进程锁验证和聚合文档检查仍未完成。

<a id="dev-note"></a>
## 开发备注

无。
