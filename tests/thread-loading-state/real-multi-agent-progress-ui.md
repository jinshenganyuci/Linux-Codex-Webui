# Feature: Real multi-agent progress UI

## Prerequisites / setup

- Build and start the current checkout on disposable port `4173`.
- Use a Codex model/configuration that can create sub-agents.
- Prepare one task that creates one sub-agent and one task that creates at least six agents, including one nested child.
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

## Rollback / cleanup

- Stop only the disposable `4173` verification process if it was started for this test.
- Do not stop or restart the persistent `5173` server or the formal `13510` console.
- No persistent test data is required; archive test threads if desired.
