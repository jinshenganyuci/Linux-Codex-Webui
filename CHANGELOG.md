# 更新日志

本文件记录 Linux-Codex-Webui 每次推送中面向用户和运维人员的重要变化。

后续提交与推送统一采用中文标题、中文详细正文和中文更新日志。代码标识符、命令、接口路径以及 Codex 协议字段保留原始英文名称，避免产生含义偏差。

## 2026-07-12

### 普通 HTTP 与 JSON-RPC 请求增加统一超时

#### 问题与目标

- 原有浏览器端大量普通 HTTP 和 `/codex-api/rpc` 请求直接调用 `fetch()`，SSH 隧道中断、Node 服务异常、Codex app-server 无响应或响应体长期不结束时，页面可能永久停留在加载状态。
- Provider models 使用独立的 5 秒 `AbortSignal.timeout()`，文件上传又维护一套 60 秒手写 `AbortController`，不同功能的超时、取消和网络错误语义不一致。
- 本次改动统一浏览器请求层，同时避免用短超时中断 Git、ZIP、Skills、Composio、账户验证和 Codex turn 等正常长操作。

#### 核心实现

- 新增 `src/api/requestClient.ts`，统一管理请求建立、响应体读取、timeout timer、调用方 `AbortSignal` 和资源清理。
- 默认普通 HTTP 请求超时为 15 秒，普通 JSON-RPC 请求超时为 30 秒，长操作超时为 120 秒；文件上传继续保持 60 秒，Provider models 继续保持 5 秒快速回退。
- 新增 `timeout` 和 `aborted` 两类 `CodexApiError` 错误码，明确区分请求超时、用户主动取消和普通网络失败。
- timeout 按请求总时长计算，覆盖响应头和响应体读取；成功、失败、超时和主动取消路径都会清理 timer 与监听器。
- timeout 只表示浏览器停止等待，不自动重试，也不声称 Git、导入、clone、worktree、Skills 或 Codex 等服务端副作用已经停止。
- WebSocket、SSE、心跳、sequence replay 和重连逻辑保持原样，不套用普通 HTTP deadline。

#### 接入范围

- `rpcCall`、RPC method/notification catalog、server request 回复和 pending request 查询统一使用 RPC timeout。
- Gateway 中的线程状态、自动化、运行配置、终端、模型偏好、工作区、Git、Review、本地目录、Telegram、prompts 等普通 HTTP 请求统一接入请求工具。
- `thread/start-turn`、大型 thread 读取、ZIP 导入导出、GitHub clone、worktree、Git checkout/reset、Review、Skills 搜索/安装/同步、GitHub 登录完成、Composio、账户验证和语音转录使用长操作策略。
- Skills Hub、Skill 详情、GitHub Skills Sync 和听写转录中绕过 Gateway 的直接请求也已迁移。
- ZIP 下载保留流式进度处理；听写继续支持用户主动取消；上传继续保留 `FormData` 自动边界处理。

#### 用户影响

- SSH 隧道或后端服务异常时，普通页面请求不再永久转圈，而会在约 15 秒后结束等待并显示明确的 timeout 信息。
- RPC 通信异常会在约 30 秒后返回带方法名的 timeout 错误，便于判断是哪个 Codex 操作未响应。
- 正常的长时间 Git、ZIP、Skills、Composio、账户同步及 Codex 操作不会被 15 秒普通请求超时误伤。
- 用户取消听写会继续被识别为主动取消，而不是显示为网络失败或 timeout。

#### 测试验证

- 新增 `src/api/requestClient.test.ts`，覆盖普通/RPC/长操作 timeout、显式毫秒覆盖、提前取消、运行中取消、网络错误分类、响应体读取超时、并发请求隔离以及 timer 清理。
- timeout 与 Gateway 窄测试共 26 项全部通过。
- TypeScript/Vue 类型检查、Vite 前端生产构建、CLI `tsup` 构建和 `git diff --check` 全部通过。
- 真实浏览器运行验证中，刻意挂起 `/codex-api/skills-hub` 后约 17.7 秒观察到 `/codex-api/skills-hub timed out after 15000ms`，加载状态自动消失；快速成功请求仍正常显示空状态。
- 全量单元测试中 201 项通过，另有 2 项 Windows 文件权限位断言失败：Windows 返回 `0666`，测试期望 POSIX `0600`；该失败与本次请求超时改动无关。

#### 部署与回滚注意事项

- 本次改动仅影响浏览器端请求等待和错误分类，不修改 Codex CLI API/Key、Session、聊天文件或服务端数据格式。
- 有副作用的操作 timeout 后应先刷新并检查实际状态，再由用户决定是否重试，避免重复创建 turn、worktree、clone 或同步任务。
- 回滚时可恢复原请求调用代码并删除 `src/api/requestClient.ts`；不会留下需要迁移或清理的持久化数据。

## 2026-07-10

### 修复任务已经结束但 WebUI 持续转圈

#### 问题与原因

- 原有前端把 `turn/completed` 实时通知当作停止转圈的必要条件。浏览器休眠、网络切换、WebSocket 半开或通知丢失后，即使 Codex 已完成任务，本地 `inProgress` 仍可能永久保留。
- 同一任务由一个 WebUI 实例启动时，其他实例自己的 Codex app-server 可能把该 turn 返回为 `interrupted` 或 `notLoaded`，因此仅轮询 `thread/read` 会把仍在运行的任务误判为结束。
- 旧版跨实例活动记录允许过期租约覆盖 Session 中已经存在的 `task_complete`，会把完成任务重新显示成运行中。
- 点击停止时，如果 Codex 返回 `no active turn to interrupt`，旧逻辑只显示错误，不会清理已经过期的 UI 状态。

#### 核心实现

- 新增独立的 `ThreadRuntimeState` 服务端模块，按 `turnId` 管理状态，不再使用线程级黏性布尔值作为权威依据。
- 对 Codex Session JSONL 进行结构化增量解析，识别 `event_msg.task_started` 和 `event_msg.task_complete`，避免反复完整解析大型会话文件。
- 状态判断以最新 turn 为单位：同一 turn 的 `task_complete` 始终是不可被租约覆盖的终态；更新的本地或外部 turn 又不会被旧 turn 的完成记录误清除。
- 每个 WebUI 实例使用独立 UUID、进程身份、端口、turnId 和心跳时间写入原子租约文件。外部租约只用于证明所属实例仍存活，10 秒没有心跳后自动失效。
- 新增批量接口 `POST /codex-api/thread-runtime-state`。该接口独立返回权威运行态，不篡改 Codex 原始 `thread/list`、`thread/read` 或 `thread/resume` 响应。
- Codex app-server 的 `turn/start`、`turn/started`、`turn/completed`、异常退出和主动停止均接入统一运行态管理。

#### 前端行为

- 运行中每 2 秒批量校验一次运行态，空闲时每 15 秒校验一次；窗口重新聚焦、页面恢复可见、网络恢复和通知流重连时立即校验。
- 权威状态为完成或中断时，自动清除输入框停止按钮、侧栏转圈、activeTurnId、实时推理文本和命令状态，并强制加载最终消息。
- 权威状态为外部实例运行时，即使当前实例的 `thread/read` 返回 `interrupted`，界面仍保持正确的运行状态。
- 事件驱动刷新失败后会重新排队并延迟重试，不再清空待刷新集合后静默丢失。
- 停止操作返回 `no active turn` 时会立即重新读取权威运行态；任务已经结束则自动恢复 UI，不再留下 502 错误和永久转圈。
- 新 turn 启动期间增加乐观状态保护，防止上一 turn 的终态在启动请求尚未完成时误清除新任务。

#### 连接健康检查

- WebSocket 服务端每 10 秒发送应用心跳并执行 ping/pong 检查，无响应连接会被主动终止。
- 浏览器端增加 25 秒无帧看门狗，半开连接会主动关闭并重连，随后立即执行运行态校验。

#### 验证结果

- 全量单元测试：17 个测试文件、193 项测试全部通过。
- TypeScript 类型检查、Vite 前端生产构建和 CLI 构建全部通过。
- 双实例真实验收中，所属浏览器被刻意丢弃 `turn/completed`，旁观实例的原始 `thread/read` 同时返回 `interrupted`；两个界面仍正确显示运行，并在 Session 完成后约 2 秒内自动停止并显示最终回复。
- 所属 WebUI 进程被 `SIGKILL` 后，旁观实例在 10 秒租约到期后自动收敛为 `interrupted`，未出现永久转圈。
- 验收期间未发现浏览器控制台错误，临时服务、测试会话和测试租约均已清理。

#### 部署与回滚

- 多实例必须全部升级到本版本，才能共同写入和读取新的 turn 运行态租约；未升级实例仍可运行，但不会提供新租约。
- 运行态文件位于 `${CODEX_HOME}/linux-codex-webui-runtime/thread-runtime-leases/`，仅保存实例和 turn 活动元数据，不保存消息、API Key 或聊天正文。
- 回滚代码不会修改 Codex Session；残留租约超过有效期后不会继续被新版本视为运行中。

### 每个聊天独立保存模型和推理强度

#### 更新内容

- 模型和推理强度改为按 thread 独立持久化，不再只依赖当前浏览器内存或全局 Codex 默认配置。
- 刷新页面、切换到其他聊天后再返回、重新打开浏览器或重启 VPS，已有聊天都会恢复各自最后一次选择。
- 只有新建聊天使用 Codex CLI 当前默认模型和默认推理强度。
- 用户仍可在任意已结束聊天中随时切换模型和推理强度，下一次发送会使用该聊天保存的配置。
- 后端新增线程模型偏好持久化接口，并通过串行写入避免快速切换时旧请求覆盖新选择。

#### 验证结果

- 覆盖刷新恢复、聊天切换、模型目录暂时不完整、`thread/read` 返回旧模型以及快速连续修改等场景。
- 保留官方推理强度名称与模型支持范围，不改变 Codex CLI 实际接收的参数值。

### 新增已归档聊天管理

#### 更新内容

- 左侧栏顶部新增“已归档”入口，并新增独立归档页面。
- 支持归档聊天搜索、刷新、分页加载和数量显示。
- 支持将聊天恢复到正常列表。
- 支持永久删除归档聊天，并提供二次确认，降低误删除风险。
- 恢复或删除后会同步刷新左侧聊天列表。

#### 兼容性说明

- 归档功能仅移植归档管理本身，没有引入此前已废弃的线程活动覆盖方案。
- 每聊天模型与推理强度持久化逻辑保持不变。
