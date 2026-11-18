---
kind: upgrade-guide
description: "内置组合包从 DSH 安装中启用，未经声明的提升依赖无法替换内置 Loader 条目。"
---

# Profile 中的内置组合包

[English](guide.md) | 中文

## 变更

`dsh plugin add` 拒绝安装 DSH 安装已提供的组合包。插件管理器可以直接启用这些组合包。DSH 安装所提供的 `@deepseek-ai/` 包在 profile Loader 中使用内置副本，除非 profile 声明并安装了同名直接依赖。过去，pnpm 提升的未声明依赖可以替换内置 Loader 条目。

## 迁移

1. 对于 `@deepseek-ai/dsh-cua-bundle` 等内置组合包，在**插件**中启用它，或在 profile 的 `package.json` 中将包名加入 `dsh.profile.bundles`。
2. 如果有意覆盖 profile Loader 条目中的包名，请将该包声明为 profile 的直接依赖并安装。其他情况使用内置副本。
3. 重启 profile 并在**插件**中检查状态。如果使用 Web 或 Desktop profile，确认侧边栏列出了保存的工作区和会话。
