### 功能：新版运行时不支持 items/list 时的有界历史降级

#### 前置条件
- 使用当前工作树的验收构建，运行时为 Codex CLI 0.159.3，或可返回 `thread/items/list is not supported yet` 的 RPC 测试桩。
- 准备分页子代理会话，最近两个回合至少一个包含最终回复；另准备命令输出超过 256 KiB、带明确首尾标记的分页回合。
- 浏览器验收使用仓库规定的测试服务；正式服务 13510 与 tmux 5173 不作重启或配置修改。
- 自动回归命令：`pnpm exec vitest run src/server/boundedThreadHistory.test.ts src/server/codexAppServerBridge.historyPagination.test.ts`。

#### 操作
1. 展开子代理结果，检查 `GET /codex-api/agent-result?threadId=<子代理会话ID>` 返回的文本、`truncated` 字段和服务端 RPC 调用。
2. 展开截断的命令输出，检查 `POST /codex-api/thread-command-output`，请求体包含 `threadId`、`turnId`、`itemId`；比较输出的首尾标记及 UTF-8 字节数。
3. 用测试桩让原生 items 接口分别返回权限失败、超时、参数错误，确认不会继续请求 turns 接口。
4. 用测试桩让第一次原生 items 请求不支持，随后恢复支持，再次读取结果。
5. 依次用测试桩制造：重复 cursor、连续 16 页仍有下一页、累计超过 1600 items、累计超过 8 MiB 的文本和结构预算、缺失 items 的非法 full turn、带 `aggregatedOutputTruncated: true` 的命令输出。
6. 检查确实读到历史末尾但未找到目标的情况，以及命令输出为空字符串的情况。

#### 预期结果
- 只有明确的 method-not-found / `-32601` / items 接口不支持错误触发降级；权限、连接、参数等错误保留，不隐藏为“找不到结果”。
- 降级请求只使用 `thread/turns/list`，固定 `itemsView: 'full'`、`sortDirection: 'desc'`、`limit: 1`，顺序跟随 cursor，不发送 `thread/read(includeTurns: true)`。
- 子代理返回最新非空回复；回复超过 64 KiB 时保留有效 UTF-8 后缀并标注 `truncated: true`。
- 完整命令输出必须同时匹配 turnId 与 itemId；300 KiB 的测试输出保持原样，空字符串也属于找到的完整结果。
- 预算耗尽、重复 cursor、非法页与已知截断输出明确报错，不能返回 HTTP 200 的“完整”片段，也不能伪装成确定不存在。到达历史末尾仍无匹配时才返回空结果或命令不存在。
- 每次明确读取最多一次失败的 items 探测，然后最多 16 次单回合顺序请求；命中结果或到达末尾立即停止。
- 不缓存不支持标志，切换运行时后下一次读取会重新探测原生接口；没有新增后台轮询、启动请求或每个子代理的并发全量扫描。

#### 性能边界
- 降级累计限制 16 页 / 1600 items / 8 MiB 解码文本及结构预算，另限制 64000 个结构节点与 32 层嵌套。预算检查不会重新 JSON 序列化整个响应。
- 运行时必须先发送单个 full turn，WebUI 才能检测该页是否超限；单回合的上游传输量尚无法由本地预算提前限制。超过预算会报错，而非截断后标为完整。
- 自动测试覆盖请求数与终止边界；真实长会话的网络时延和峰值内存需在集成验收阶段测量。

#### 回滚与清理
- 删除仅用于测试的临时会话/桩数据；不得删除真实会话。
- 回滚相关提交会恢复原来仅 items/list 的读取路径；在不支持该接口的运行时，子代理结果与完整输出读取会再次失败。
