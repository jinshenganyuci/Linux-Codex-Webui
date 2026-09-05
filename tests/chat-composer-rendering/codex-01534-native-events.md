### Feature: 原生请求关闭、非阻塞澄清与新运行消息

#### Prerequisites
- 13511 隔离实例可用；按仓库规则在 4173 启动同版本验收服务器，使用不同于正式实例的 CODEX_HOME。
- 创建项目 `/tmp/codex-webui-phase1-TestChat` 及 README，真实 Astra 回答包含 `PHASE1_ASTRA_20260905` 和 `[README.md](README.md)`，记录 thread ID。

#### Steps
1. 运行 `PHASE1_THREAD_ID=<id> node scripts/verify-codex-phase1.cjs`，覆盖桌面、375×812、768×1024 和明暗主题。
2. 检查 README 链接渲染行与 `hrefOk/titleOk/textOk`，保存 TestChat 截图。
3. 注入字符串 ID、`isBlocking: false` 的提问：独立表单可回答，普通聊天输入可用，文案不得再称必须回答才能继续。
4. 注入相同线程/generation 的 `serverRequest/resolved`，随后重复通知、刷新页面，再注入旧 generation 与其他线程事件。
5. 注入安全缓冲、验证要求、认证恢复、重路由、终态事件；同时检查刷新后的 runtime-state，确认过期快照不能撤销较新的事件。
6. 在真实消息列表检查 sleep、functionCallOutput、subAgentActivity、hookPrompt、未知类型的折叠卡；展开文本，检查转义、截断及子线程链接。
7. 运行 `pnpm run test:unit`，核对普通消息没有被非阻塞表单吞掉，以及数字 ID 与同内容字符串 ID 不混淆。

#### Expected Results
- 原生结束的提问按未作答关闭，不伪造答案；手动答案不会被迟到的原生通知覆盖。
- 关闭后刷新不复活表单；线程/generation 隔离、快照竞争与已知重复请求幂等处理。
- 安全缓冲不被当成任务完成或卡死；验证独立提示且不自动通过；认证消息不泄漏凭据，未知消息不直接输出 JSON。
- 新消息在明暗主题清晰、移动端无水平溢出；原生非文本输出不宣称已有完整图片支持。

#### Rollback/Cleanup
- 浏览器 fixture 只存在于单独上下文，不向真实 CLI 发送虚构回答；退出脚本即可清理。
- 保存 `output/playwright/phase1-browser-report.json` 与截图。保留 4173 验收服务器，除非另行要求关闭。
