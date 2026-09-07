# Feature: Real multi-agent progress UI

## Prerequisites / setup

- Use the current isolated acceptance service on `13511`; do not create another WebUI listener.
- Use a Codex model/configuration that can create sub-agents.
- Prepare one task that creates one sub-agent and one task that creates at least six agents, including one nested child.
- Prepare both a legacy thread and a paginated thread that can run the one-agent task.
- Keep browser developer tools available to inspect `/codex-api/agent-progress`, `/codex-api/agent-result`, and the notification stream.

## Actions and expected results

1. Open a thread and send the one-agent task.
   - The live card starts in a compact state; the `Subtasks N` / `子任务 N` control has `aria-expanded=false`. With no children, it reads `Activity log` / `活动记录` without zero-count placeholders.
   - The card header shows `Main task` / `主任务`, one phase label, duration and compact model/thinking/speed details; expanding shows only child agents, and collapsing removes the details from the accessibility tree.
   - The phase changes between preparing, reasoning, dispatching, waiting, executing, applying changes, and summarizing based on real notifications.
   - Elapsed time and last-activity time advance without displaying a fabricated percentage or ETA.
2. Send the six-agent task.
   - All agents use the same row layout; no special case is required for four, five, or six agents.
   - Each child row shows compact model and reasoning labels from that child's own rollout, with raw values retained in title attributes. Compare agents with different values and confirm they are not copied from the main model or another child; missing child speed must remain absent.
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

## 2026-09-07：紧凑状态卡与详情排版

| Before | After | Why |
| --- | --- | --- |
| 主状态重复、Model/Thinking/Speed 文字折行 | 主任务状态与耗时同排，模型/强度/速度单独紧凑一排 | 手机可以快速扫读 |
| 统计和“查看代理活动”分占空间，零子任务显示 0/0 | 数量和分类统计合并到展开按钮；无子任务显示活动记录 | 减少无效信息 |
| 运行态整圈蓝边，详情名称/路径/打开链接重复 | 中性细边框、状态点，子任务名称本身可点击 | 保留状态区分并减轻视觉负担 |

前置条件：13511 保持独立验收服务，`output/playwright/chatgpt-preview/thread.json` 指向已完成 TestChat。先构建前端。脚本使用 Playwright 修改主题、拦截进度和运行状态，真实页面仍从 13511 加载；这是可重复协议回放，不能报告为本轮实际新建了六个代理。

```bash
pnpm exec vitest run src/server/agentProgressTracker.test.ts src/server/codexAppServerBridge.historyPagination.test.ts src/components/content/turnProgressUtils.test.ts src/composables/useDesktopState.test.ts
pnpm run build:frontend
BASELINE=1 node scripts/verify-agent-progress-polish.cjs
node scripts/verify-agent-progress-polish.cjs
# 发布 13511 后，直接检查线上产物，仍只回放协议而不发送消息：
LIVE_PREVIEW=1 node scripts/verify-agent-progress-polish.cjs
```

操作及预期：

1. 在 1440×900、375×812、768×1024 明暗主题打开目标 TestChat，显示 3 个子任务，统计为 1 运行、2 完成。默认详情关闭，只有一个主阶段标签，模型信息没有英文字段前缀，零统计不显示。
2. 展开详情，3 个子行的模型/强度与各自回放数据一致。完成结果在点击前请求 0 次、点击后 1 次。手机以弹层展示，Shift+Tab 不越出弹层，Esc 关闭后焦点返回打开按钮。
3. 刷新仍显示三个引用；改为六节点含一个二级节点，层级、完成、中断、失败可区分。再回放零节点，按钮只显示活动记录。所有状态无横向溢出，暗色无浅色卡片。
4. 结束关闭测试浏览器上下文，并等待/忽略仍在进行的拦截请求，避免测试退出时的 TargetClosedError。脚本不调用 spawn/turn/start，不写速度或配置，保留原 TestChat。

已通过：上述 228 项单测、前端构建、六组页面回放。移动端相同摘要高度 150→112px；桌面与平板为 104px。每组四次加载对应四次进度请求，无重复进度轮询；点击结果仅一次。1 万事件回放中位 13.22ms、最大 44.72ms（10 次），节点/事件/去重键/线程映射保持 64/120/240/65。主 JS +312 字节、聊天 JS +1211、主 CSS +1799、聊天 CSS 不变，合计 gzip +970；未测真实低端手机或本轮实际模型并发时延。

实际 URL 为 `http://127.0.0.1:13511/#/thread/01a0797c-faa5-70a0-b29e-b4c92c0bb03c`。完整断言在 `output/playwright/agent-progress-polish/browser.json`，截图绝对路径为 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/agent-progress-polish/after-{compact,expanded}-{1440,375,768}-{light,dark}.png`。前后比较、资源体积及压测记录位于同目录 `baseline.json`、`bundle.json`、`performance.json`。

375×812 浅色，紧凑摘要：

![手机紧凑任务状态卡](/root/codex工作目录/Linux-Codex-Webui/output/playwright/agent-progress-polish/after-compact-375-light.png)

375×812 深色，子任务详情与按需结果：

![手机深色子任务详情](/root/codex工作目录/Linux-Codex-Webui/output/playwright/agent-progress-polish/after-expanded-375-dark.png)
