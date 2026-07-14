# Feature: Real multi-agent progress UI

## Prerequisites / setup

- Build and start the current checkout on disposable port `4173`.
- Use a Codex model/configuration that can create sub-agents.
- Prepare one task that creates one sub-agent and one task that creates at least six agents, including one nested child.
- Keep browser developer tools available to inspect `/codex-api/agent-progress`, `/codex-api/agent-result`, and the notification stream.

## Actions and expected results

1. Open a thread and send the one-agent task.
   - The live card shows the main agent and child in one tree.
   - The phase changes between preparing, reasoning, dispatching, waiting, executing, applying changes, and summarizing based on real notifications.
   - Elapsed time and last-activity time advance without displaying a fabricated percentage or ETA.
2. Send the six-agent task.
   - All agents use the same row layout; no special case is required for four, five, or six agents.
   - Nested agents are indented beneath their actual parent.
   - Completed, interrupted, failed, running, waiting, stale, and disconnected states are visually distinct.
3. Expand the timeline.
   - Structural events appear newest first and remain bounded.
4. Expand a completed agent result.
   - The result is fetched only after the click.
   - Loading and error states are visible; oversized results show that only the final portion is displayed.
5. Reload the page while agents are active, then briefly interrupt the notification connection or restart only the disposable app server.
   - The selected thread recovers its graph from `/codex-api/agent-progress`.
   - Connection loss is shown separately from a silent/stale agent.
   - A stopped app-server reconciles active work to interrupted instead of leaving an endless spinner.
6. Repeat in light and dark themes at desktop width, `768x1024`, and `375x812`.
   - Desktop shows the inline tree and timeline.
   - Mobile shows a compact summary and an accessible bottom sheet; focus enters the sheet, remains trapped while open, and returns to the opener after close.
   - Text, status dots, hierarchy rails, buttons, results, and errors remain readable in both themes.
7. Stream many small agent-message, reasoning, and command-output deltas.
   - UI updates are grouped rather than rendered once per character.
   - Background-thread output stays isolated from the selected thread.
   - Live output remains byte-bounded and the page stays responsive.

## Rollback / cleanup

- Stop only the disposable `4173` verification process if it was started for this test.
- Do not stop or restart the persistent `5173` server or the formal `13510` console.
- No persistent test data is required; archive test threads if desired.
