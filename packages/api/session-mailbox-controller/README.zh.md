# 会话信箱控制器

[English](README.md) | 中文

本文参考说明 Web bundle 装配的浏览器授权、仅排队 Remote 控制器。它负责路由授权和选取句柄；[信箱库](../../experimental/session-mailbox/README.zh.md)负责持久记录及私有根目录的合作锁。profile 将根目录固定为 `profileContext.dir + '/session-mailbox'`；Remote 调用者不能指定存储路径。

## 权限与操作

每个方法都要求存在 invocation，且其 Peer 必须是 Host 构造时捕获的同一 `connection.browserPeer` 对象。owner principal、`interactions: answer`、自报身份或 API operator 都不够。浏览器认证不证明发生了真人点击：已认证的浏览器标签页共享同一 Peer，并非独立安全主体。UI 将授权行为显式呈现；拥有该浏览器权限的调用者仍代表账户所有者。

`identity` 返回非秘密的逻辑信箱 realm 和当前支持的 `single-owner` 域。它不是认证凭据，也不是硬件 Host 身份。`grant` 要求预期身份仍匹配，并为选定 source/target 的发送路由，或指定 target 的收件/确认路由授权，最长 30 秒。`prepare` 在该路由上冻结一次操作并返回随机不透明句柄。`execute` 在等待前消费句柄，再通过内部适配器执行操作。`revoke` 取消该路由的全部选取，包括正在执行的 lease。所有操作均不会调用 Agent、注入 prompt，或将普通引用变成指令。

Host 最多保留 32 个 grant 和 64 个未消费选取。消息正文上限为 16 KiB UTF-8。grant 与选取共用平台单调时钟；grant 截止时间只能缩短选取寿命。定时器负责回收资源，不负责建立权限有效性。执行时以及返回正文前仍必须检查当前权限和生命周期。响应仅投影消息 id、来源、目标、正文、状态、可信度和投递模式，不包含存储 principal key。

关闭控制器时先取消 grant，再排空并关闭独占的信箱。撤销或过期之前已经提交的写入不会回滚；其结果可能暂不可知。使用相同发送 request id，或相同确认 receipt id，重新显式选取并通过当前授权后可核对操作。不存在、已归档、subagent 和待迁移的目标仍被拒绝；运行中的普通目标只接收记录，不会被中断。

独立的 `session_mailbox_identity` 域版本为 1，只有包含 UUID 的一条 `owner` 记录。它在同一私有根目录锁内初始化，提交成功后才发布适配器；状态不可读或无效时拒绝打开。新增该元数据不重写原消息记录。重开保留 realm，不同根目录生成不同 realm。复制或恢复身份文件会保留逻辑 realm，而非硬件身份；移除该文件会创建新分区。当前 Host 权限模型没有多 owner 登录身份。

## 验证与限制

生成契约整合测试要求先运行仓库的仅源码 Typert 生成。测试在明确的临时 `DSH_HOME` 中使用真实 Gateway、Connection、RemoteAccess 和 JSON 持久化，不使用真实用户 Session 或凭据。依赖制品的用例沿用仓库约定，在缺少生成制品时跳过；接纳此控制器要求实际执行这些用例，而不能以跳过代替通过。

浏览器入口为[会话信箱 UI](../../client/ui-session-mailbox/README.zh.md)。此处不实现面向模型的 send/read 工具、绑定真实 Agent 的路由授权、持久审计事件、多 Host 存储或 trigger-turn 投递。后续 Agent 工具必须将真实执行的 Agent 和 Session 绑定到用户授予的目标，不能借用浏览器 owner 权限。发布前仍需补齐翻译 sidecar 和完整仓库检查。

`profileContext.dir` 由启动器提供；同一 DSH home 下独立 Web 与 Desktop profile 使用独立私有根目录和逻辑 realm。没有启动器 profile 时默认禁用此条目，可信自定义装配须提供明确私有根目录。不会自动迁移或合并旧全局候选信箱。同一 profile 根目录仍拒绝第二个进程打开。此条目不属于 app-boot 的必需启动集合：锁或打开失败会警告并使信箱不可用，不会退回无锁存储，也不是整应用的必需失败。

仅当持久服务经过当前授权与同标识查重，确认没有记录且尚未写入时，特定无效正文或容量/完整序列化记录超限才返回 `outcome: not-accepted`。实际 UTF-8 预算包含 JSON 转义及终态字段；原正文上限不保证完整记录可容纳。prepare、普通拒绝、冲突、取消和存储/网络未知结果均不证明未投递。UI 仅凭该明确结果或成功回执释放重试草稿。
