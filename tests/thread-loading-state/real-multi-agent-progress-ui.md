# Feature: Real multi-agent progress UI

## Prerequisites / setup

- Use the current isolated acceptance service on `13511`; do not create another WebUI listener.
- Use a Codex model/configuration that can create sub-agents.
- Prepare one task that creates one sub-agent and one task that creates at least six agents, including one nested child.
- Prepare both a legacy thread and a paginated thread that can run the one-agent task.
- Keep browser developer tools available to inspect `/codex-api/agent-progress`, `/codex-api/agent-result`, and the notification stream.

## Actions and expected results

1. Open a thread and send the one-agent task.
   - The live card starts in a compact state; `Show agent details` / `展开代理详情` has `aria-expanded=false`.
   - The card header always shows `Main reasoning model` / `主推理模型` with model, thinking, and speed details; expanding agent details shows only child agents, and collapsing removes the child tree from the accessibility tree.
   - The phase changes between preparing, reasoning, dispatching, waiting, executing, applying changes, and summarizing based on real notifications.
   - Elapsed time and last-activity time advance without displaying a fabricated percentage or ETA.
2. Send the six-agent task.
   - All agents use the same row layout; no special case is required for four, five, or six agents.
   - Each child row shows `Model` and `Thinking` from that child's own rollout. Compare agents with different values and confirm they are not copied from the main model or another child; when Codex does not record a child speed, no fabricated `Speed: Standard` or `Speed: Fast` is shown.
   - Nested agents are indented beneath their actual parent.
   - Completed, interrupted, failed, running, waiting, stale, and disconnected states are visually distinct.
   - Before reloading the page, a completed root with completed child results shows zero active agents and `Completed N/N`; trailing token-usage or goal notifications do not revert child rows to `Running`.
3. Expand the timeline.
   - Structural events appear newest first and remain bounded, independently of whether agent details are expanded.
4. Expand a completed agent result.
   - The result is fetched only after the click.
   - Loading and error states are visible; oversized results show that only the final portion is displayed.
5. Reload the page while agents are active, then briefly interrupt the notification connection or restart only the disposable app server.
   - The selected thread recovers its graph from `/codex-api/agent-progress`.
   - Recovered child rows retain their own rollout-backed model and thinking details after refresh.
   - If the first progress request is delayed or fails, persisted messages remain visible and no empty `Thinking` / `思考强度` card appears.
   - A later runtime-state poll retries the missing progress snapshot and expands the real tree without a browser refresh or thread switch.
   - Missing or failed progress snapshots retry with bounded backoff instead of issuing a request on every two-second runtime poll.
   - A response from an invalidated previous turn or a stopped polling session cannot overwrite the current turn's retry/progress state.
   - Connection loss is shown separately from a silent/stale agent.
   - A stopped app-server reconciles active work to interrupted instead of leaving an endless spinner.
   - For overlapping Goal continuation turns, keep a newer continuation without a completion record inactive after the restart, then let an earlier turn finish later. The root card changes to `Completed` / `已完成` without F5 because that later completion is the newest authoritative lifecycle event.
   - A child that truly has no completion record remains `Interrupted` / `已中断`; the root correction does not fabricate a child completion.
   - While the newer continuation still has a fresh runtime lease, an older completion must not replace its `Running` / `运行中` state.
   - After a child starts turn B, delayed completion/runtime evidence from its turn A does not stop B; a fresh runtime owner for B can resume a terminal A row.
   - After the root turn is terminal, delayed same-turn activity or a replayed `turn/started` event does not restore `Running` / `运行中`.
   - A `turn/start` response ID without matching `turn/started` or session `task_started` evidence remains provisional, is never published in the cross-instance runtime lease, and cannot keep the card running after a real terminal lifecycle event.
   - A separately confirmed newer turn remains running when an overlapping older turn completes, including a silent task whose lease heartbeat remains fresh for several hours.
   - When runtime switches the root from turn A to B, a delayed turn A progress response is discarded; the card stays empty until real turn B progress arrives and then renders B.
   - Completed, failed, and interrupted rows show a frozen `Duration` / `耗时`; their labels do not keep increasing after completion.
6. While a turn is running, deliver an app-server `error` notification with `willRetry: true`, followed by a non-retry error.
   - Automatic retry text such as `Reconnecting... 2/5` does not render as a red final-error alert and does not show a feedback action.
   - The active progress card remains visible while Codex retries.
   - A notification with `willRetry: false`, or a failed `turn/completed`, still renders the actionable error.
7. Repeat in light and dark themes at desktop width, `768x1024`, and `375x812`.
   - Desktop shows the compact card first and reveals the inline tree only after the explicit agent-details toggle.
   - Mobile shows a compact summary and an accessible bottom sheet; focus enters the sheet, remains trapped while open, and returns to the opener after close.
   - Text, status dots, hierarchy rails, buttons, results, and errors remain readable in both themes.
8. Stream many small agent-message, reasoning, and command-output deltas.
   - UI updates are grouped rather than rendered once per character.
   - Background-thread output stays isolated from the selected thread.
   - Live output remains byte-bounded and the page stays responsive.
9. Run the one-agent task in the paginated thread, wait for `turn/completed`, switch away and back, then scroll far enough to move that turn between loaded pages.
   - The completion path requests `thread/items/list` for the completed root `turnId` rather than re-reading the whole thread.
   - Parent/child rows, the child's own model/thinking metadata, completion state, and lazily fetched result survive item reconciliation, cache revisit, and older-page prepend.
   - A delayed child-result or progress response from the previously selected thread cannot overwrite the currently selected thread.
   - Reopening the unchanged completed paginated thread uses cached rows without another resume/read/items request; a real version change refreshes only the affected page/turn.

## Rollback / cleanup

- Preserve the existing acceptance service and its data directory after verification.
- Do not stop or restart the persistent `5173` server or the formal `13510` console.
- No persistent test data is required; archive the disposable legacy/paginated test threads if desired.

## 2026-09-07：续用子任务丢失回归

- 前置条件：父会话的第一回合已创建子任务；第二回合只继续交互或接收完成消息，没有新的 started。使用捕获的协议元数据或隔离 13511 回放，不操作正式任务。
- 操作：第一回合结束后开始下一回合，接收 `subAgentActivity kind=interacted`，再接收 completed；刷新状态恢复，并读取子线程自己的当前回合。还需发送迟到的前一父回合事件，以及子线程向父线程的回复。
- 预期：仅当前回合真正引用的子任务进入统计，打开详情有正确路径；不会把父线程本身加入子列表。完成引用可恢复节点及结果入口，但没有子回合 ID 的摘要不能结束已知较新子回合；刷新后的真实子历史决定最终状态。再次交互不把已完成节点伪装成执行中。
- 命令：`pnpm exec vitest run src/server/agentProgressTracker.test.ts src/server/codexAppServerBridge.historyPagination.test.ts`。60 项通过；新增三项在修复前失败。分页恢复的 started/interacted 两种路径各验证三个摘要、三个有界回合页，无完整历史读取。
- 用户截图对应父会话当前回合的纯协议回放，修复前为 0 个子节点、修复后为 3 个；证据在 `output/playwright/agent-progress-polish/reported-thread-evidence.json` 和 `replayed-{before,after}.json`，只保留元数据和生命周期，不含实际提示词、命令输出或凭据。
- 清理与回退：没有创建实际子任务或修改原会话；回退需部署旧版前后端。旧版仍会漏掉没有新建事件的续用子任务，不应把回退后的 0/0 解释为没有子任务。
