---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-session-directory-requests

[English](2026-11-14-session-directory-requests.md) | 中文

## 概述

记录 Session 的目录选择。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-session-directory-requests
baseline: false
changes:
  - root: "event:sandbox/roots-requested"
    previous: null
    after: "fa8800e5c6dcf0bdb48dc544297cb31de6d1093472f31c8fccc1a5a95afa88ce"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取器可读取没有该事件的旧日志。旧读取器拒绝该必读事件。回放恢复目录选择，写入策略保持不变。

<a id="verification"></a>
## 验证

定向测试已覆盖发布前快照、空白 Session 复用、JSONL 恢复、旧读取器拒绝和分叉前缀恢复。

<a id="dev-note"></a>
## 开发备注

无。
