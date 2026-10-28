# Agent Note: Next 桌面能力长期目标

Status: proposed

[English](2026-10-28-next-desktop-capability-goals.md) | 中文

## 问题

维护者于 2026-10-28 明确提出 DSH-Next 的十三类长期能力目标和交互回归测试。仅依赖聊天记录会丢失验收细节和未完成工作。现有能力记录各自拥有具体机制，不拥有这组产品目标。

## 提案

以本提案作为长期目标和覆盖情况的持久载体。独立能力分别实现，并按审阅后的证据更新对应行；新会话、测试失败或平台不可用都不意味着目标结束。保留稳定编号；通过链接逐项可验收的子目标扩充 G13，不悄然替换原始十三项目标。本表不声称任何能力一定缺失或已经可用。

### 先调研再实现

对每项目标，先检查已配置的插件市场来源和现有已交付或实验性 bundle。登记来源 URL 与获取日期、包名和版本、许可证、维护与兼容证据、权限、支持行为、剩余缺口及复用决定。市场不可用或为空属于明确的调研缺口，不证明没有插件。不得仅为完成调研而添加不可信来源或安装代码。优先复用适用且受维护的能力；未覆盖行为先通过已有文档定义的扩展点实现，再考虑修改核心。

[市场决策](../../implemented/feature/2026-10-02-plugin-market-discover.zh.md)描述的是没有官方默认索引的可选实验性市场。[会话引用](../../implemented/architecture/2026-09-15-client-session-references.zh.md)、[显式 worktree](../../implemented/feature/2026-09-13-explicit-worktree-creation.zh.md)、[侧会话](2026-07-08-interactive-side-sessions.zh.md)和[桌面更新](2026-09-08-desktop-update-policy-and-installation.zh.md)记录继续拥有各自的决策与验证要求。本提案不替代它们，也不将文档存在视为运行验收证据。

### 目标与覆盖登记

来源 U 指维护者于 2026-10-28 提出的要求；O 指当日查阅的公开官方 `dsh-v0.2.2-alpha.2` 源文件，不是 B0 构建；P 指下方注明日期的第三方来源。状态 S 表示兼容性确认及运行验收待核验，不表示尚未实现。随证据推进使用 planned、implementing、blocked、verifying 或 accepted 状态；受阻时记录操作、目标、原因及解阻条件。T 为下方共享验收矩阵。B0 标识包版本 `0.2.1-rc.3` 及本提案查阅的源文件。本提案列出的完整验收矩阵尚未执行；既有功能测试不自动覆盖本提案全部目标。“版本/SHA”栏必须链接到记录仓库身份、版本、被测完整提交 SHA、平台和时间的 PR（Pull Request）或 CI 产物；维护文档按照[引用规则](../../../../docs/AGENTS.md#repository-references)保存该链接，而非直接写提交标识。

| ID | 目标 | 状态 | 来源 | 依赖 / 复用决定 | 可观测验收条件 | 未覆盖 | 版本 / SHA 证据 | 测试证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G01 | 将会话条目拖入当前聊天作为引用 | S | U, O | [会话引用快照](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/context/session-reference/README.md)；复用输入原子，增加拖拽 | 拖放、切换与重启后来源和目标正确；取消不发送内容或改变源会话 | T 未运行；失效/已删除引用 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G02 | 文件路径和 Markdown 右键操作：打开文件、所在目录及相关安全操作 | S | U, O | [宿主校验的打开操作](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/client/ui-open-in-app/README.md)、G06；增加消息入口 | 支持的本地目标打开正确文件/目录；缺失、拒绝、远程或不支持目标明确说明结果 | T 未运行；路径/平台情况 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G03 | 窗口缩放时内容宽度自适应 | S | U | [现有宽度控件](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationWidthControls.tsx)；先评估布局再考虑插件 | 窄宽窗口、最大化和还原时重新排版，无控件截断或滚动/焦点丢失；缩放比例改变后仍可操作 | T 未运行；长代码/表格/消息内容 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G04 | 经授权的跨会话发现、调用、主动通知与交流 | S | U, O | [Agent Teams](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/tool-agent-team/README.md)限定团队，不是任意会话访问；仍需显式授权 | 每项操作标明授权范围；撤销/未授权时拒绝；未授权会话保持隔离；防止循环及通知重复 | T 未运行；并发投递、撤销和重连 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G05 | 拖拽调整排队任务顺序 | S | U, P | 队列所有权/持久化；input-traffic 候选待评估 | 新顺序可见且保留；取消拖拽和并发完成不重复、丢失或意外执行任务 | T 未运行；空/单条/运行中队列 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G06 | 所有同类右键菜单按光标定位并限制在视口内 | S | U | 共用菜单定位与全部调用处；待调研 | 菜单在预期光标处打开，各边缘自动约束/翻转，滚动、窗口和比例缩放后仍可触达；键盘触发有明确锚点 | T 未运行；子菜单与全部调用处 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G07 | Git 分支选择与 worktree 管理 | S | U, O | [Forge 候选](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/forge-bundle/README.md)及显式 worktree 所有者；独立吸收待评估 | 分支/检出目录与会话目录一致；脏状态、重名和部分失败可见；不隐式执行破坏性清理 | T 未运行；游离/缺失分支、共享元数据权限 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G08 | 额度/余额小图标 UI | S | U, O | [现有账户 UI](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/client/ui-settings-account/README.md)；区分金额、上下文 token 与订阅额度 | 紧凑图标清晰呈现加载、可用、过期与错误状态，详情可访问并支持刷新行为 | T 未运行；无账户、额度限制和刷新竞态 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G09 | 对标题和聊天内容执行异步关键词全文搜索 | S | U | 现有 SQLite FTS/索引启用、取消；待调研 | 标题和消息命中均定位正确且不阻塞输入；新查询覆盖旧查询；不泄露已删除或未授权会话 | T 未运行；空/大型/多语言索引、过期结果 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G10 | 全局会话置顶、工作区置顶与最近区域 | S | U, O | [现有会话置顶/最近记录](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/client/ui-workspace/README.md)；工作区置顶与独立全局区域仍待评估 | 全局与工作区范围独立；移动、删除和重启后排序及最近记录保持一致 | T 未运行；重复视图、空工作区和持久化 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G11 | 自有仓库自动更新使用正确 channel 和 manifest（元数据清单） | S | U, O | [应用壳拥有的更新器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/apps/desktop/src/update-channel.ts)、release 可用性及 feed；不归普通插件所有 | 已安装应用检查正确仓库/channel，解析对应平台元数据/产物；缺失 release/manifest 与认证或网络失败明确区分 | T 未运行；初始无 release / nightly.yml 404 报告；已安装版本升级及恢复 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G12 | 普通聊天 fork、新 worktree fork、手动标为未读、任务完成 OS 通知默认开且可关闭 | S | U, O | [会话 fork](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/docs/subsystems/session.md)、G07、未读持久化、原生通知桥接；进程内提醒不足以满足要求 | 分别测试：普通 fork 不建 worktree 且源历史不变；worktree fork 隔离；手动未读保留；默认开启偏好仍遵循 OS 权限、关闭设置和通知去重 | T 未运行；worktree 部分失败、重启、通知点击目标 | B0；待新增目标验收产物 | 本目标新增验收待记录 |
| G13 | 对照公开可核验的 ChatGPT/Codex 桌面和 Claude Desktop 能力扩充遗漏项 | S | U | [ChatGPT/Codex fork 模式](https://learn.chatgpt.com/docs/reference/slash-commands)、[Claude 桌面](https://code.claude.com/docs/en/desktop)；注明日期的对照与插件调研 | 每个新增子目标注明 URL、访问日期、相关产品/版本/平台及证据；验收前区分已验证行为、推断和不可获取的证据 | 公开对照及所有派生 UI 用例待核验 | B0；待对照/版本证据 | 本目标新增验收待记录 |

### 初步调研发现

2026-10-28 查阅的 [dsh-input-traffic 市场条目](https://dsh.pub/en/plugins/dsh-input-traffic/)列出版本 `0.2.9`。其排序候选通过移除后重发重建队列，并非原子调整顺序，且排除图片条目。静态审阅发现并发认领风险，并非已观测的运行故障；进一步验证前不能据此认定 G05 达标。被查阅的精确源修订保留在链接的证据产物中。

[官方 forge bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-alpha.2/packages/experimental/forge-bundle/README.md)候选的包版本为 `0.2.2-alpha.2`，与 B0 不同。其新会话 worktree/基准分支选择器是 G07 的复用候选，不证明 B0 已包含它，也不证明可将现有聊天 fork 到 worktree。评估独立吸收并保留原许可证与作者归属；G12 仍需独立验收。

B0 已含 [SQLite 查询实现](../../../../packages/session-query/session-query-sqlite/README.zh.md)，但 [Web 组合](../../../../packages/bundle/web-app/cordis.patch.yml)配置为 `openAt: never`。新增搜索引擎前先评估索引启用、资源占用、增量刷新、取消及错误反馈。其文档中的词项/短语匹配不是任意子串匹配；必须明确并测试 G09 的关键词语义。

### 共享交互验收矩阵

对每项目标及适用子操作应用 T：正常、空、加载、错误、取消、重复操作、键盘/焦点、Escape/外部点击、窗口及比例缩放、拖放、重启/持久化和平台差异。仅在说明原因后才可将某维度标为不适用。逐个用例记录 pending、pass、fail、blocked 或 not applicable；未测试和跳过绝不计为通过。G12 的两种 fork、未读状态与通知必须分别记录结果。

使用隔离的合成工作区/账户及受支持的桌面/Web 启动入口。结合定向单元/集成检查、相关免密钥快照、真实 UI 交互检查以及必要的桌面/OS 集成，遵循所属[测试规范](../../../../docs/testing.zh.md)。每次执行在证据产物中保留命令或可复现步骤、预期/实际结果、时间、平台/应用版本和被测完整 SHA。截图用于辅助视觉检查，不能替代真实交互运行。保留修复前失败、回归覆盖、修复与修复后重跑记录，并再次测试受影响的相邻行为。

目标是完整覆盖已枚举能力及适用 UI 状态，不承诺 100% 无 bug。分别报告用例覆盖、代码覆盖及支持平台覆盖，并列明分母和缺口；不得将一种百分比当作另一种。OS 受阻或缺失凭据是明确的待完成结果，不是通过。回归或新增支持平台使证据失效时，重新打开已验收目标。

### 安全与证据归属

跨会话操作必须具有明确、可撤销的授权，标明发现/读取/调用/通知范围，隔离未授权会话，限制转发并防循环，且对通知去重。会话引用或另一会话的消息不授予权限。文件操作通过所属宿主能力验证并授权目标；绝不把任意显示路径或 Markdown 转为 shell 命令，也不扩大文件系统权限。

使用合成 fixture（测试前置数据），不使用真实会话历史、凭据或私有项目名。私有截图不进入公开仓库；发布前脱敏证据，绝不记录 Cookie、token 或认证请求头。G11 的缺失 release 或 manifest 及 HTTP 404 不代表 token 故障；诊断授权前先核实仓库、release、channel、平台及产物可用性。即使应用偏好默认开启，完成通知仍受 OS 权限约束。

## 考虑过的替代方案

**仅在聊天中保留目标。** 上下文变化会丢失范围及未验证用例，不满足明确持久化目标的要求。

**另建跟踪框架或复制现有能力决策。** 稳定表格行和证据链接适配现有提案生命周期，维护更少且不引入工具；机制细节继续由现有文档拥有。

**全部在核心实现，或仅凭截图或覆盖率宣称成功。** 这会跳过可复用插件，也无法验证生命周期、安全或原生集成行为。复用决定与已执行的验收证据仍是独立要求。

## 验收条件

- 十三项目标均保留原始范围、稳定编号、来源、依赖/复用决定、状态、可观测验收、未覆盖用例、构建/SHA 证据引用与测试证据。
- 实现前，每项目标记录插件/来源调研结果或具体阻塞，并明确可复用的现有能力。
- 已验收行具有 T 及特定验收用例的已执行证据；缺陷修复并重跑，未完成平台与不可用服务仍清晰可见。
- 同步更新两种语言及一致性记录。任何目标或派生子目标未验收时，本提案保持开放；全部解决后保留决策理由和证据链接，按既有已实现记录格式转换，不遗留过时清单。

## 风险

长期登记可能与已交付代码脱节；每次实现或回归都更新对应行，并针对被测修订重新核验证据。插件可用性及对照产品会变化，必须注明公开证据日期，不可获取的行为保持未知。大量 UI 状态组合需要安排执行优先级，但不能借此抹去未覆盖用例或弱化授权、隐私和平台检查。
