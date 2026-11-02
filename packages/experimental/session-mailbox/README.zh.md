# 仅入队会话信箱候选实现

[English](README.md) | 中文

供[浏览器信箱控制器](../../api/session-mailbox-controller/README.zh.md)使用的内部持久库；本包本身不注册 Remote 或模型工具。`SessionMailbox` 使用现有 storage-domain 服务及其 JSON 后端；同一权威记录同时提供收件箱与发件箱视图，无需跨 Session（会话）事务。Host 必须独占存储根目录。

## 准入与投递

Host 将不透明调用者能力解析为显式 principal、规范 principal key 和来源 Session。工具传入的身份字段及缺失的 invocation 均不隐含 owner 权限。准入、读取、取消和确认都会查询当前注入策略。策略负责来源发送权、目标接收权、工作区/账号与生命周期限制。不提供无限制历史查询或权限转移。禁止向自身投递。

`send` 仅保存调用者提供的文本，并标记为 `untrusted-agent-content`。唯一投递模式为 `queue-only`；没有 Agent（智能体）依赖、唤醒选项、恢复、转发、自动回复或模型可见输入注入。`ack` 仅确认信箱收件，不代表 Agent 轮次完成。只有接收方可以确认；只有原发送 Session 和 principal 可以取消。取消与确认串行执行，只能有一次终态转换获胜。

重试键限定于 Host 规范 principal 和发送 Session。仍满足当前授权与目标接收准入条件的重试返回原收据，包含终态；改变目标或文本会冲突。终态记录保留为去重墓碑。限制覆盖保留记录数量及完整记录的 UTF-8 字节数，计入最长终态。返回记录是隔离快照。已中止的 signal 阻止准入；持久写开始后的取消不会撤回接受结果。

授权在串行准入点、持久写开始前检查。写入期间撤权不会取消或改变已接受的消息或确认；解析出的身份与请求值已经捕获。后续重试、读取和确认使用当前权限。若集成的 Remote 适配器要求响应时仍有权限，必须在写入后重新检查，并隐藏已无权访问的响应，不回滚已提交状态。列表读取不会看到未提交记录。

写入复用 storage-domain 串行机制及 storage-json 原子替换，不新增文件锁。任何写失败都会隔离该服务，因为 rename 可能已成功，而确认失败。关闭并重新打开后，先校验介质再重试。权威介质被截断时拒绝读取，不会清空收据重新开始。这提供持久重试对账，不承诺恰好一次执行。

## 内部 Host 适配器

`/host` 导出是程序内部 helper，不是 RPC endpoint。`withHostMailbox` 拥有独立 JSON 后端及完整信箱生命周期。固定 `privateRoot` 由可信 Host 组装选择，绝不是 Remote 参数；检查 POSIX 所有权及私有权限，不修改已有权限。适配器在打开存储前复用现有 `withFileLock`，仅在已接受操作、domain 与后端排空后释放锁。遵守同一协议的第二个实例不能同时打开同一规范目录。Windows 根目录 ACL 隐私仍是组装前提，不由此检查证明。

只有可信 Host 用户选取处理器可以调用适配器的 issuer。不透明进程内能力绑定确切的已认证 Peer 实例、操作及所选 Session；发送还捕获文本和重试键。执行要求匹配且存活的 `ctx.invocation.peer`。排队操作 claim 选取时恰好消费一次，包括被拒绝或已过期的 claim。后续校验使用内部操作 lease，所有结果都会释放该 lease；下一次调用必须重新显式选取。缺失 invocation、伪造 owner 字段、其他连接和已释放 Peer 都被拒绝。首版只接受本机 owner。RemoteAccess 会检查确切的 `sessionMailbox/send`、`sessionMailbox/inbox` 或 `sessionMailbox/ack` 动作及相关 Session 资源，但它有意对 owner 放行；强制 Host 选取能力是另一层独立限制。不注册公开 issuer、模型工具或 Remote 路由。

Host 必须配置 1 至 30,000 毫秒的 `selectionTtlMs`。异步边界前后都校验单调时钟截止时间，包括空收件箱的最后一次生命周期探测。签发时检查签发 invocation 的 signal，但选取另有必填独立 `cancelSignal`：签发 RPC 正常完成不等于取消选取。未来 UI 处理器必须在用户取消时明确取消选取。同一存活 Peer 的后续 invocation 可以在过期前 claim 一次；并发和顺序重放均拒绝。已开始的持久写不因 lease 过期或取消而回滚。如果写入已接受，但结果已无权展示，适配器返回不含消息内容的 `outcome-unavailable`，不声称没有发送。核对结果必须重新授权选取同一发送方、目标、文本和请求 id；持久去重返回已有收据。

适配器只读取 SessionStore header 或 `sessionPersistence.stat`，不读取历史，不调用 `resolveAgent`。冷态普通 Session 无需恢复即可接收；运行中的普通 Session 同样仅保存队列记录，不 steer 或中断。不存在、已归档、源自 subagent 或需要迁移的 Session 被拒绝。收件箱和确认要求目标当前有效；持久写后还会重查响应。归档或删除可能隐藏响应，但不撤回已接受记录。生命周期探测与信箱持久化不在同一原子事务中：存在性快照后的删除可能留下孤立收据，但不会激活 Agent。不支持复用已删除 Session 的 id。

文件锁仅适用于同主机、同 PID namespace 的合作进程。它探测记录的 PID，在重新校验 takeover claim 后仅接管已证实退出的持有者，不让存活持有者的锁过期。它不防外部参与者替换活锁；最终释放按路径删除，不校验 inode/nonce。不完整锁记录与遗留 takeover claim 可能保守拒绝并需要人工检查。不支持跨主机共享存储、恶意替换或绕过 helper。本适配器不将底层存储后端升级成通用多进程事务服务。

## Model Experience

没有 prompt、工具、模型请求、token 成本或 KV Cache 影响：此候选实现不向模型暴露信箱内容。未来接入输入投递时，必须在模型可见前记录带来源归属的专用 Session 事件。

适配器在发布前、同一锁内初始化版本为 1 的 `session_mailbox_identity` 域。其持久 UUID 只是非秘密逻辑分区标识，绝不是授权凭据；消息记录保留原格式。

可信 Host 签发选取时可提供更早的单调时间截止点。它只能缩短配置的 TTL，确保路由授权不会在排队或等待持久化期间越过权限期限。

## 已知限制与后续工作

- 原始 `SessionMailbox` 仍要求单 Host 写入。其 JSON 后端不强制跨进程租约；第二个进程可能覆盖记录。不支持多个独立 facility 操作同一根目录，不声称多进程安全。
- 浏览器 Remote 和 UI 装配归独立的控制器与 UI 包所有。尚无模型工具和调度集成，完整发布检查仍未完成。
- 没有 trigger-turn 操作。未来独立授权的调度器必须在激活时重查目标权限和生命周期、要求用户显式授权、保存持久激活收据，并限制路由深度和激活预算。接受入队本身绝不授权执行。
- 只接收原始文本；没有附件、来源对话捕获或转发。不提供 Agent 间自动转发，因此不能形成自动唤醒循环。人工重复发送仍受策略和配额限制。
- 记录保留发送者 principal key 和终态，但尚无追加式拒绝/转换审计流、时间戳、过期机制或保留记录压缩器。删除终态记录会使现有重试保证失效。
- 原始服务将生命周期决策交由 Host 策略处理；内部适配器实现上述保守的 header-only 策略。二者均不物化 Session。
- 测试使用真实 JSON 持久化、RemoteAccess、Peer、SessionStore 和 WorkspaceRegistry，以受控的仅元数据持久化替身构造冷态 Session 竞态。另覆盖延迟可见性、显式选取绑定、归档/删除响应竞态、一次性 claim、同 Peer 后续 invocation、独立取消、真实文件发布期间的单调时间过期、空收件箱最终探测期间取消及合作实例互斥。底层测试覆盖真实 JSON 后端、重启、同进程并发发送、取消/确认竞态、伪造能力、撤权、限制、截断介质和发布后确认丢失。不模拟操作系统进程死亡或断电，也不证明跨进程互斥。

## 源码对照

现有相邻 Agent 通信位于 `packages/subagent/subagent/src/manager.ts`（`sendMessage`、`submitAdmitted`）：后者在 steer 和 queue 两种投递后都会唤醒目标。现有同 team 对等通信位于 `packages/experimental/agent-team/src/index.ts`（`sendAdmitted`），通过 team root 转发，同样会 steer 活跃 Agent。二者均非面向独立 Session 的仅入队信箱。`packages/typert/protocol/src/principal.ts` 有意将 owner 和缺失 invocation 都归一为 undefined；本候选实现不能将这种归一用作模型工具的授权依据。
