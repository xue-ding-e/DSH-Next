---
kind: upgrade-guide
description: "Workspace 实现必须提供源目录以及原子配置操作。"
---

# Workspace 源目录

[English](guide.md) | 中文

## 变更

导出的 `Workspace` 接口要求提供 `sourcePaths`、`primaryPath` 和 `configure(title, sourcePaths?)`，实现此接口的代码必须补齐这些成员。`path` 仍为注册时的原始规范目录，可以与新 Session 使用的主目录不同。移除次级来源后，已有 Session 保留自己的工作目录和归属。

Workspace Remote 投影可选地包含 `sourcePaths`，省略表示 `[path]`。`workspace.rename` 请求接受可选的有序列表，并将其与标题一起保存。已有单目录记录无需转换。

挂载 Workspace 注册表后，`workspace-write` 现在会授权写入 Session 所属 Workspace 的全部当前来源，并与部署配置的 `additionalWritableRoots` 合并。此前选择来源不会增加写权限。保存的来源编辑在下一次操作生效。移除来源或卸载注册表会撤销派生授权；显式部署授权继续保留。每个现有 Session 继续以不可变的原始 cwd 作为工作区根目录。为 Session 归属保留的历史来源不授予额外写权限。`read-only` 仍不可写，`danger-full-access` 仍不受限制。

## 迁移

1. 更新自定义 `Workspace` 实现，提供有序源目录，并将首个目录作为 `primaryPath`。实现 `configure` 时，确保来源无效或写入失败都会同时保留标题和目录列表。保持原始 `path` 不变。
2. 为新 Session 选择目录时使用 `primaryPath`，Remote 投影则使用 `sourcePaths?.[0] ?? path`。原始注册身份和层级仍使用 `path`。
3. 在 `workspace-write` 下，将每个配置的来源视为写入授权进行审查。移除不应允许写入的目录，或选择 `read-only`。仅为移除来源或卸载注册表后仍需保留的授权配置部署级 `additionalWritableRoots`。
4. 验证来源保存后重载仍保留、新 Session 使用所选主目录，以及已有 Session 日志保持不变。确认 `workspace-write` 允许写入已配置的同级来源、拒绝未列出的同级目录，且 `read-only` 拒绝写入所有来源。
