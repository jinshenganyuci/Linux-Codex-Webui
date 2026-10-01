### Invalid or expired auth errors appear in chat

#### Feature/Change Name
Invalid Codex auth failed-turn error rendering.

#### Prerequisites/Setup
1. Build the project with `pnpm run build`.
2. Build a fresh Docker image from the packed artifact.
3. Start a Docker container with an invalid or expired `auth.json` mounted into `CODEX_HOME`.
4. Open the container URL in the browser.

#### Steps
1. Confirm `config/read` uses the default Codex provider path with no WebUI-injected provider fallback.
2. Send `hi` from the composer.
3. Wait until the turn stops running.
4. Reload or reopen the same thread.
5. Repeat in dark theme and light theme.

#### Expected Results
- The failed turn displays the final auth error in the chat, including the HTTP 401/unauthorized message from Codex.
- The failed turn includes a visible `Send feedback` button next to the persisted chat error.
- Once the failed turn is persisted, the live `Thinking` error overlay is gone so the final auth error is not duplicated.
- The conversation does not silently show only the user message after a failed turn.
- Reloaded thread history preserves the failed-turn error message.
- Automatic retry notifications such as `Reconnecting... 2/5` do not appear as a red final-error alert or expose a `Send feedback` action; the final non-retry error remains visible after completion.
- In dark theme and light theme, the feedback button remains readable and opens a feedback mailto with the visible auth error included in the diagnostic body.

#### Rollback/Cleanup
- Stop the invalid-auth Docker container after verification.

---

### 中断回合的错误原因（Codex 0.159.3）

- 前置条件：隔离的 13511 验收环境；准备 `turn/completed` 的 `status: interrupted` 且 `error.message` 非空的通知，以及同一回合的 legacy / paginated 历史记录。
- 操作：接收通知，查看真实聊天错误行和回合状态，然后刷新会话；分别使用明暗主题验证。再对照用户主动停止且 `error: null` 或空白字符串的回合。
- 预期：有错误时即时展示原因，刷新后保留且不叠加重复 live error；回合和计划终态保留“已中断”。无错误的正常停止不凭空生成红色错误消息。
- 清理：移除隔离测试会话和通知 fixture；本用例不使用真实账号凭据或正式服务。
