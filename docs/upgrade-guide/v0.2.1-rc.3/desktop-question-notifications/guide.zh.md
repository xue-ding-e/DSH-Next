---
kind: upgrade-guide
description: "自定义问题界面必须提供 Workspace 导航，以支持桌面通知激活。"
---

# 桌面问题通知

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-user-questions` 的 Client 插件要求提供 `uiWorkspace`。自定义 Client 组合必须提供此导航服务，使系统通知可以打开问题所属的 Session。随产品提供的 Web 和 Desktop 组合已提供该服务。

桌面通知使用 preload 的 `dshDesktop.questionNotifications` 能力，本机偏好默认启用。普通 Web 客户端在会话内显示问题，不注册通知设置或额外的提醒卡片。

## 迁移

1. 在加载问题界面的自定义组合中加入 [`@deepseek-ai/dsh-client-ui-workspace`](../../../../packages/client/ui-workspace/README.zh.md) 及其文档所列依赖。
2. 同时更新桌面壳、preload 和问题界面。桌面环境缺少通知能力时会报告发送失败，问题仍可正常作答。
3. 最小化桌面窗口后触发问题，确认点击系统通知可以恢复窗口、打开来源 Session 并展开问题。确认关闭问题通知后，该偏好在重新加载后仍保留。
