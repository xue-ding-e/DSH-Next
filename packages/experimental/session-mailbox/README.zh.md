# 仅入队会话信箱候选实现

[English](README.md) | 中文

内部候选实现，并非已注册插件或已启用的跨会话产品功能。`SessionMailbox` 使用现有 storage-domain 服务及其 JSON 后端；同一权威记录同时提供收件箱与发件箱视图，无需跨 Session（会话）事务。Host 必须独占存储根目录。

## 准入与投递

Host 将不透明调用者能力解析为显式 principal、规范 principal key 和来源 Session。工具传入的身份字段及缺失的 invocation 均不隐含 owner 权限。准入、读取、取消和确认都会查询当前注入策略。策略负责来源发送权、目标接收权、工作区/账号与生命周期限制。不提供无限制历史查询或权限转移。禁止向自身投递。

`send` 仅保存调用者提供的文本，并标记为 `untrusted-agent-content`。唯一投递模式为 `queue-only`；没有 Agent（智能体）依赖、唤醒选项、恢复、转发、自动回复或模型可见输入注入。`ack` 仅确认信箱收件，不代表 Agent 轮次完成。只有接收方可以确认；只有原发送 Session 和 principal 可以取消。取消与确认串行执行，只能有一次终态转换获胜。

重试键限定于 Host 规范 principal 和发送 Session。仍满足当前授权与目标接收准入条件的重试返回原收据，包含终态；改变目标或文本会冲突。终态记录保留为去重墓碑。限制覆盖保留记录数量及完整记录的 UTF-8 字节数，计入最长终态。返回记录是隔离快照。已中止的 signal 阻止准入；持久写开始后的取消不会撤回接受结果。

授权在串行准入点、持久写开始前检查。写入期间撤权不会取消或改变已接受的消息或确认；解析出的身份与请求值已经捕获。后续重试、读取和确认使用当前权限。若集成的 Remote 适配器要求响应时仍有权限，必须在写入后重新检查，并隐藏已无权访问的响应，不回滚已提交状态。列表读取不会看到未提交记录。

写入复用 storage-domain 串行机制及 storage-json 原子替换，不新增文件锁。任何写失败都会隔离该服务，因为 rename 可能已成功，而确认失败。关闭并重新打开后，先校验介质再重试。权威介质被截断时拒绝读取，不会清空收据重新开始。这提供持久重试对账，不承诺恰好一次执行。

## Model Experience

没有 prompt、工具、模型请求、token 成本或 KV Cache 影响：此候选实现不向模型暴露信箱内容。未来接入输入投递时，必须在模型可见前记录带来源归属的专用 Session 事件。

## 已知限制与后续工作

- 只支持单 Host 写入。JSON 后端不强制跨进程租约；第二个进程可能覆盖记录。不支持多个独立 facility 操作同一根目录，不声称多进程安全。
- 没有 Remote endpoint、模型工具、Loader 注册、UI、生产权限适配器、调度集成或默认 bundle。不具备发布条件。
- 没有 trigger-turn 操作。未来独立授权的调度器必须在激活时重查目标权限和生命周期、要求用户显式授权、保存持久激活收据，并限制路由深度和激活预算。接受入队本身绝不授权执行。
- 只接收原始文本；没有附件、来源对话捕获或转发。不提供 Agent 间自动转发，因此不能形成自动唤醒循环。人工重复发送仍受策略和配额限制。
- 记录保留发送者 principal key 和终态，但尚无追加式拒绝/转换审计流、时间戳、过期机制或保留记录压缩器。删除终态记录会使现有重试保证失效。
- 冷态、已归档、已删除或 one-shot Session 的接收决策交由可信 Host 策略处理。服务不会物化任何 Session。
- 测试覆盖真实 JSON 后端、重启、同进程并发发送、取消/确认竞态、伪造能力、撤权、限制、截断介质和发布后确认丢失。不模拟操作系统进程死亡或断电，也不证明跨进程互斥。

## 源码对照

现有相邻 Agent 通信位于 `packages/subagent/subagent/src/manager.ts`（`sendMessage`、`submitAdmitted`）：后者在 steer 和 queue 两种投递后都会唤醒目标。现有同 team 对等通信位于 `packages/experimental/agent-team/src/index.ts`（`sendAdmitted`），通过 team root 转发，同样会 steer 活跃 Agent。二者均非面向独立 Session 的仅入队信箱。`packages/typert/protocol/src/principal.ts` 有意将 owner 和缺失 invocation 都归一为 undefined；本候选实现不能将这种归一用作模型工具的授权依据。
