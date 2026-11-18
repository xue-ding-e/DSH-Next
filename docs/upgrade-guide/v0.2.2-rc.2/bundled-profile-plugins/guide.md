---
kind: upgrade-guide
description: "Bundled plugins are enabled from the installation and undeclared hoisted packages cannot replace bundled Loader entries."
---

# Bundled plugins in profiles

English | [中文](guide.zh.md)

## Change

`dsh plugin add` refuses packages that the DSH installation already supplies as bundles. The Plugin Manager can enable those bundles directly. Profile Loader entries for installation-supplied `@deepseek-ai/` packages select the bundled copy unless the profile declares an installed direct dependency on the same name. An undeclared package hoisted by pnpm could previously replace a bundled Loader entry.

## Migration

1. For a bundled package such as `@deepseek-ai/dsh-cua-bundle`, enable it in **Plugins** or select its name in `dsh.profile.bundles` in the profile's `package.json`.
2. If you intentionally override a name in a profile Loader entry, declare and install that package as a direct dependency of the profile. Otherwise, use the bundled copy.
3. Restart the profile and check the plugin state in **Plugins**. On a Web or Desktop profile, confirm the sidebar lists the saved workspaces and sessions.
