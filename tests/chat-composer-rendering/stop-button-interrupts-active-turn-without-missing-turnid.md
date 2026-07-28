### Feature: Stop button interrupts active turn without missing turnId

#### Prerequisites
- App is running from this repository.
- At least one thread can run a long response (for example, request a large code explanation).

#### Steps
1. Send a prompt that keeps the assistant generating for several seconds.
2. Immediately click the `Stop` button before the first assistant chunk fully completes.
3. Confirm generation halts.
4. Repeat with a resumed/existing in-progress thread (reload app while a turn is running, then click `Stop`).
5. If the backend has advanced the thread to a newer active turn while the page still shows the previous one, click `Stop` once.
6. While turn A is running, send a steer prompt whose `turn/start` response returns turn B but never emits `turn/started` for B; then let A complete and click the stop area immediately.
7. Repeat step 6 with a real `turn/started` event for B before A completes.
8. Leave an older WebUI instance publishing a fresh lease for ghost turn B without any matching session `task_started`; after the real turn A has completed, open the same thread in the current WebUI and click the stale stop control before the next runtime poll.

#### Expected Results
- No error appears saying `turn/interrupt requires turnId`.
- Turn is interrupted successfully in both immediate-stop and resumed-thread scenarios.
- If a cached turn ID is stale, the WebUI reconciles to the backend's active turn and retries once; no `expected active turn id ... but found ...` error is shown.
- An RPC-only turn B is treated as provisional: A's real completion clears the progress card and restores the send control within two seconds.
- Clicking during that reconciliation never leaves a red `no active turn to interrupt` error.
- A cross-instance ghost lease without session lifecycle evidence expires after the confirmation window, even if the older instance keeps refreshing its heartbeat.
- If the stale click races with reconciliation and returns `thread not found`, the WebUI applies the terminal runtime state and shows no red RPC error.
- A genuinely confirmed turn B remains running when the older turn A completes.
- A confirmed multi-hour task remains running while its owner lease heartbeat is fresh.
- Thread state exits in-progress and the stop control returns to idle.

#### Rollback/Cleanup
- None.
