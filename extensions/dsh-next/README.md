# DSH-Next extension plugins

English | [中文](README.zh.md)

This directory contains this repository's own community plugins; they are **not part of upstream DeepSeek Harness**. They install as profile bundles (`file:` self-contained installation + `dsh.bundle.patch`) without modifying the installed DSH artifacts.

Installation (ask the agent in DSH to run this, or call plugin_manager yourself):

```
install_bundle(target: <本目录下的绝对路径>)
```

## Contents

| Plugin | Purpose | Restart required |
|---|---|---|
| `dsh-browser-control` | Lets the model operate the built-in browser tab directly: navigate, take snapshots, click, fill forms, read text, and evaluate code. **Reuses that tab's signed-in Cookie** | Yes (client half) |
| `dsh-nav-buttons` | Uses mouse side buttons X1/X2 to go back and forward through a unified history of sessions, panels, and sidebar tabs | Yes (client half) |
| `dsh-input-guard` | Shows a persistent, stoppable banner at the top of the page when a program wants to operate your real mouse and keyboard | Yes (client half) |

All three are **available by default**; `dsh-browser-control` screenshots are unavailable in this DSH version (see below).

## Upgrade versus uninstall: will sign-in state be lost?

Browser Cookies are stored in **userData**, not `~/.dsh`:

| Location | Contents | On uninstall | On upgrade |
|---|---|---|---|
| `~/.dsh` | Profiles, plugin installations, session index | **Preserved** | Preserved |
| `%APPDATA%\@deepseek-ai\dsh-desktop` | **Cookies, cache, Local State** | **Deleted** | Preserved |
| Installation directory | Application files | Deleted | Replaced |

- **Upgrade installation**: `un.CleanData` starts with two early returns, `${If} ${isUpdated} Return` and `/KEEP_APP_DATA`, and clears nothing. Routine updates are safe.
- **Actual uninstall**: runs `RemoveData "$APPDATA\@deepseek-ai"`, deleting `Partitions\` too — **sign-in state is lost with it**.
- `~/.dsh` is safe because the uninstaller can only read `DSH_HOME` at the system environment-variable level, while it actually exists only in the process environment. `$UnHome` is therefore empty and outside the deletion scope.

To keep sign-in state, copy the partition directory before uninstalling and restore it after reinstalling:

```powershell
Copy-Item "$env:APPDATA\@deepseek-ai\dsh-desktop\Partitions" "$env:USERPROFILE\dsh-partitions-backup" -Recurse
# 重装后
Copy-Item "$env:USERPROFILE\dsh-partitions-backup\*" "$env:APPDATA\@deepseek-ai\dsh-desktop\Partitions\" -Recurse
```

Partition names are derived deterministically from the workspace path (`sha256("cwd:<path>")[:32]`), so they still match after being copied back.

## dsh-browser-control

Registers seven model-visible tools, all operating on **the built-in browser tab visible to the user**. Its Cookie / localStorage / sign-in state is therefore the user's existing state, without another login.

| Tool | Description | Status |
|---|---|---|
| `browser_goto` | Navigate to an http(s) URL | Tested and working |
| `browser_snapshot` | Return interactive elements and text with stable `ref` values | Tested and working |
| `browser_click` | Click by ref or CSS selector | Tested and working |
| `browser_fill` | Fill a form and dispatch input/change | Tested and working |
| `browser_read_text` | Read visible text | Tested and working |
| `browser_eval` | Evaluate code in the page and return JSON | Tested and working |
| `browser_screenshot` | **Unavailable** | See below |

**Why screenshots are unavailable**: `<webview>` exposes no capture methods to the renderer (`capturePage` / `getWebContents` both go through Electron's guest IPC proxy, which reads `null` in the isolated world and throws `GUEST_VIEW_MANAGER_CALL`). The Desktop preload bridge (`apps/desktop/src/preload-browser.ts`) exports only `acquire` / `release` / `onOpenRequested`. This is a limitation of DSH itself that plugins cannot bypass. The tool now returns an explicit explanation and suggests `browser_snapshot` / `browser_read_text` instead.

**Read-only diagnostics**: `GET /tool-sidebar-browser-diagnostics` returns `{pageAttached, polls, resolves, toolsRegistered}` to show whether the page half is connected. It contains no page content or URL and cannot drive any actions.

## dsh-nav-buttons

One unified history stack, where a "location" is `session|panel|tab`:

- The **session** axis reads the entry in `sessions.list` with `retainedBy.mainView > 0`.
- The **panel** axis reads `layout.panelInfo.activePanelId`.
- The **tab** axis reads `sidebarRight.mounted`.

Side buttons are **not intercepted** inside the sidebar browser `<webview>`: that is a real web page, so its own history is preserved.

**Read-only diagnostics**: `GET /tool-nav-buttons/status` returns `pageHalf` (whether it ran), `visits` / `backs` / `forwards`, and `sources` (whether the four axes are reachable).

## dsh-input-guard

**Visible authorization** to operate the real mouse and keyboard. The Host half maintains a lease with a 15-second TTL:

```
POST /tool-input-guard/request   → 申请（附 purpose）
POST /tool-input-guard/beat      → 续期；撤销后返回 granted:false
POST /tool-input-guard/stop      → 用户点 Stop，标记 revoked
POST /tool-input-guard/release   → 归还
GET  /tool-input-guard/state     → 当前状态
```

The Client half renders a persistent banner in `shell.overlay`: an amber dot, purpose, elapsed time, and a **Stop button**. `shell.overlay` sits above all panes and outside every scroll container, so it cannot be scrolled away or obscured.

**What it guarantees**: programs cannot operate the mouse and keyboard **silently** through this plugin, and the user can stop them at any time.
**What it does not guarantee**: scripts that bypass this plugin can still move the mouse — this is a consent UI, not a sandbox.

## Tests

Each plugin includes Node tests (no dependency installation needed):

```powershell
cd extensions/dsh-next/dsh-browser-control; node --test tests/*.test.mjs
cd extensions/dsh-next/dsh-nav-buttons;     node --test tests/*.test.mjs
cd extensions/dsh-next/dsh-input-guard;     node --test tests/*.test.mjs
```

Currently: 6 / 15 / 12 tests, all passing.

## Installation consistency check

The profile installs these plugins using `link:`, so *the installed copy is this directory*. However, a link may point to the wrong location (such as an old source copy), silently running outdated code.

```powershell
pwsh -File extensions/dsh-next/check-install.ps1
```

- Exit code 0: all three plugin links point to this directory.
- Exit code 1: lists **specific** problems (link points elsewhere / broken link / not installed).
- Exit code 2: the profile directory does not exist.

This script **does not** use hashes to "prove" a linked installation is correct: both ends of the link are the same file, so equal hashes are not evidence. It checks the **link target**, which is what can actually be wrong.

## Client bundle structure check

Client bundles load as ordinary `<script>` elements, not modules. Three patterns cause a blank shell or an exception when the plugin calls `apply`, while the user sees only a blank page:

| Error | Symptom |
|---|---|
| Top-level `export` / `import` | Blank page |
| Calls `require(...)` but the factory does not accept that parameter | `require is not defined` when the factory runs |
| Accepts `require` but bundles its own React | Hooks attach to the wrong dispatcher |

```powershell
pwsh -File extensions/dsh-next/check-bundles.ps1
```

Exit code 0 means all three bundles are loadable classic scripts.

## Refresh the page after changing the client half

`plugin_manager`'s `set_plugin` reloads only the **host half**. Client bundles are cached by `rev`, and loaded page modules **do not execute again**. Without refreshing after changing `lib/client.js`, the page still runs the old code.

`/tool-nav-buttons/status` exposes this mismatch directly through `shapeStale`:

```json
{"pageHalf":"reported","shape":1,"shapeStale":true}
```

`shapeStale: true` means "the page half is old code and needs a refresh".

## License

Apache-2.0
