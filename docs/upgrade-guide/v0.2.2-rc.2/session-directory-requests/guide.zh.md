---
kind: upgrade-guide
description: 旧版读取器会拒绝包含目录选择的 Session 日志。
---

# Session 目录选择

[English](guide.md) | 中文

## 变更

带附加目录默认设置的新 Session 会记录必读的 `sandbox/roots-requested` 事件。读取器必须识别该事件才能打开这些日志。现有日志仍可读取。该事件恢复目录选择，本身不携带执行授权。

## 迁移

1. 在共享新日志前，升级所有用于读取、导入或分叉这些 Session 的 DSH 安装。
2. 在升级后的应用中重新打开 Session。已保存的目录选择和原工作目录会从日志恢复。

参阅[持久化变更记录](../../../persistence-changes/2026-11-14-session-directory-requests.zh.md)。
