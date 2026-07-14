### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode is scoped to the current chat instead of becoming the default for every chat, and Fast mode follows the live Codex model catalog.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two existing threads are available
3. Model list includes `gpt-5.4` or a `gpt-5.4-*` variant and `gpt-5.5` or a `gpt-5.5-*` variant
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open thread A, open the composer add menu, and enable Plan mode.
2. Open thread B and confirm Plan mode is off by default.
3. Return to thread A and confirm Plan mode remains on for that thread.
4. Open Start new thread, enable Plan mode, send a first message, and confirm the created thread starts in Plan mode.
5. Return to Start new thread again and confirm Plan mode is off for the next new chat.
6. Select a model whose current `model/list` entry exposes a Fast service tier, and confirm the Fast mode switch is visible.
7. Select a model whose catalog entry has no Fast service tier and confirm the switch is hidden when Standard mode is active.
8. Confirm a native Codex provider that exposes Fast for the selected model sends `serviceTier: "fast"` for a new turn.
9. With stale `service_tier = "fast"` configuration on an unsupported model, confirm the switch remains visible only so Fast can be turned off and the model trigger does not show a bolt.
10. Switch to dark theme and repeat the relevant steps.

#### Expected Results
- Enabling Plan mode in one existing thread does not enable it in other existing threads.
- A new-chat Plan mode selection applies to the created chat but does not persist as the default for later new chats.
- Fast mode availability comes from the live `model/list` service-tier metadata instead of model-name matching.
- Native Codex providers can use Fast when their live model catalog exposes a Fast tier for the selected model.
- A stale Fast configuration can always be disabled without falsely showing Fast as effective.
- Composer controls and menus remain readable in light and dark themes.

#### Rollback/Cleanup
- Turn Plan mode off in any test threads if desired.

---
