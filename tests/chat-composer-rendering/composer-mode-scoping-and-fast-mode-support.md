### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode is scoped to the current chat, persists through the WebUI backend across browsers, and Fast mode follows the live Codex model catalog. A one-turn Ask-first option can request structured clarification without changing the thread's saved mode.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two existing threads are available
3. Model list includes `gpt-5.4` or a `gpt-5.4-*` variant and `gpt-5.5` or a `gpt-5.5-*` variant
4. Light theme and dark theme both available from the appearance switcher
5. A second browser profile or private window for cross-browser mode verification

#### Steps
1. In light theme, open thread A, open the composer add menu, and enable Plan mode.
2. Open thread B and confirm Plan mode is off by default.
3. Return to thread A and confirm Plan mode remains on for that thread.
4. Open Start new thread, enable Plan mode, send a first message, and confirm the created thread starts in Plan mode.
5. Return to Start new thread again and confirm Plan mode is off for the next new chat.
6. Refresh thread A and confirm its Plan mode indicator remains on.
7. Open thread A in the second browser profile and confirm the Plan mode indicator is also on there; disable it, refresh the first browser, and confirm the first browser now shows Default mode.
8. Open the composer add menu, enable **Ask first, then plan**, and confirm a removable **Ask first** chip appears while the persistent Plan mode setting remains unchanged.
9. Send a deliberately ambiguous request. Inspect `turn/start` and confirm it uses `collaborationMode.mode = "plan"`, contains one-turn `developer_instructions`, and leaves the visible user message unchanged. Answer the resulting structured questions.
10. Send another ordinary message and confirm the one-turn instructions are absent and the thread still uses its previously saved Default/Plan mode.
11. While a turn is active, enable **Ask first, then plan** and send another prompt; confirm it is queued and retains the one-turn instructions when the backend starts it.
12. Select a model whose current `model/list` entry exposes a Fast service tier, and confirm the Fast mode switch is visible.
13. Select a model whose catalog entry has no Fast service tier and confirm the switch is hidden when Standard mode is active.
14. Confirm a native Codex provider that exposes Fast for the selected model sends `serviceTier: "fast"` for a new turn.
15. With stale `service_tier = "fast"` configuration on an unsupported model, confirm the switch remains visible only so Fast can be turned off and the model trigger does not show a bolt.
16. Switch to dark theme and repeat the relevant steps at desktop, `375x812`, and `768x1024` viewports.

#### Expected Results
- Enabling Plan mode in one existing thread does not enable it in other existing threads.
- A new-chat Plan mode selection applies to the created chat but does not persist as the default for later new chats.
- Existing-thread mode is stored under `CODEX_HOME`, so refreshes and other browsers use the same authoritative selection; old `localStorage` Plan entries migrate only when no backend state exists.
- **Ask first, then plan** applies to exactly one turn, uses the native collaboration-mode `developer_instructions` field, queues instead of steering an active turn, and never silently changes the thread's saved mode.
- The one-turn instruction asks only for material clarification; a fully specified request may proceed directly to a plan rather than inventing a redundant question.
- Fast mode availability comes from the live `model/list` service-tier metadata instead of model-name matching.
- Native Codex providers can use Fast when their live model catalog exposes a Fast tier for the selected model.
- A stale Fast configuration can always be disabled without falsely showing Fast as effective.
- Composer controls and menus remain readable in light and dark themes.

#### Rollback/Cleanup
- Turn Plan mode off in any test threads if desired.
- Disable any unsent **Ask first** chip; sent one-turn state clears automatically.

---
