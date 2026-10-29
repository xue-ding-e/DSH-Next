# DSH-Next 扩展插件

本目录是本仓库自有的社区插件，**不属于上游 DeepSeek Harness**。它们以
profile bundle 的形式安装（`file:` 自包含安装 + `dsh.bundle.patch`），
不修改已安装的 DSH 产物。

安装方式（在 DSH 里让 agent 执行，或自行调用 plugin_manager）：

```
install_bundle(target: <本目录下的绝对路径>)
```

## 目录

| 插件 | 作用 | 需要重启 |
|---|---|---|
| `dsh-browser-control` | 让模型直接操作内置浏览器 tab：导航、快照、点击、填表、读文本、求值。**复用该 tab 已登录的 Cookie** | 是（client 半） |
| `dsh-nav-buttons` | 鼠标侧键 X1/X2 在「会话 / 面板 / 侧栏标签」的统一历史里后退前进 | 是（client 半） |
| `dsh-input-guard` | 当有程序要操作你真实鼠标键盘时，在页面顶部显示常驻、可停止的提示条 | 是（client 半） |

三者都**默认可用**；`dsh-browser-control` 的截图能力在本版 DSH 中不可用（见下）。

## dsh-browser-control

注册 7 个模型可见工具，全部作用于**用户可见的那个内置浏览器 tab**，因此
Cookie / localStorage / 登录态就是用户自己的那份，不需要重新登录。

| 工具 | 说明 | 状态 |
|---|---|---|
| `browser_goto` | 导航到 http(s) URL | 实测可用 |
| `browser_snapshot` | 返回可交互元素 + 文本，带稳定 `ref` | 实测可用 |
| `browser_click` | 按 ref 或 CSS 选择器点击 | 实测可用 |
| `browser_fill` | 填表单并派发 input/change | 实测可用 |
| `browser_read_text` | 读可见文本 | 实测可用 |
| `browser_eval` | 页面内求值并回传 JSON | 实测可用 |
| `browser_screenshot` | **不可用** | 见下 |

**为什么截图不可用**：`<webview>` 不向 renderer 暴露任何捕获方法
（`capturePage` / `getWebContents` 都经 Electron 的 guest IPC 代理，
在隔离世界读到 `null` 并抛 `GUEST_VIEW_MANAGER_CALL`）；Desktop 的 preload 桥
（`apps/desktop/src/preload-browser.ts`）只导出 `acquire` / `release` /
`onOpenRequested`。这是 DSH 本体的能力边界，插件层面无法绕过。
工具已改为返回明确说明，并建议改用 `browser_snapshot` / `browser_read_text`。

**只读诊断**：`GET /tool-sidebar-browser-diagnostics` 返回
`{pageAttached, polls, resolves, toolsRegistered}`，用于判断页面半是否连通，
不含页面内容、URL，也无法驱动任何东西。

## dsh-nav-buttons

一个统一历史栈，一个"位置"是 `session|panel|tab`：

- **会话**轴读 `sessions.list` 里 `retainedBy.mainView > 0` 的那一项
- **面板**轴读 `layout.panelInfo.activePanelId`
- **标签**轴读 `sidebarRight.mounted`

侧键在侧栏浏览器 `<webview>` 内**不劫持** —— 那里是真实网页，保留它自己的历史。

**只读诊断**：`GET /tool-nav-buttons/status` 返回 `pageHalf`（是否执行）、
`visits` / `backs` / `forwards`、以及 `sources`（四个轴是否可达）。

## dsh-input-guard

操作真实键鼠的**可见授权**。Host 半维护一个 15 秒 TTL 的租约：

```
POST /tool-input-guard/request   → 申请（附 purpose）
POST /tool-input-guard/beat      → 续期；撤销后返回 granted:false
POST /tool-input-guard/stop      → 用户点 Stop，标记 revoked
POST /tool-input-guard/release   → 归还
GET  /tool-input-guard/state     → 当前状态
```

Client 半在 `shell.overlay` 渲染常驻横幅：琥珀圆点、用途说明、已用时长、
**Stop 按钮**。`shell.overlay` 在所有栏之上、不在任何滚动容器内，滚不走也遮不住。

**它保证什么**：程序无法通过本插件**悄悄**操作键鼠，且用户随时能停。
**它不保证什么**：绕过本插件的脚本仍能动鼠标 —— 这是同意界面，不是沙箱。

## 测试

每个插件自带 Node 测试（无需安装依赖）：

```powershell
cd extensions/dsh-next/dsh-browser-control; node --test tests/*.test.mjs
cd extensions/dsh-next/dsh-nav-buttons;     node --test tests/*.test.mjs
cd extensions/dsh-next/dsh-input-guard;     node --test tests/*.test.mjs
```

当前：6 / 15 / 12 项，全部通过。

## 安装一致性检查

profile 用 `link:` 安装这些插件，所以 *安装副本就是本目录*。但链接可能指向
错误位置（例如指向一个旧的源码副本），那样跑的就是过期代码且毫无提示。

```powershell
pwsh -File extensions/dsh-next/check-install.ps1
```

- 退出码 0：三个插件的链接都指向本目录
- 退出码 1：列出具**体**问题（链接指向别处 / 链接已断 / 未安装）
- 退出码 2：profile 目录不存在

注意该脚本**不会**用哈希"证明"链接安装的正确性 —— 链接两边本来就是同一个文件，
哈希相等不构成证据。它检查的是**链接目标**，这才是真正会出错的地方。

## 许可

Apache-2.0
