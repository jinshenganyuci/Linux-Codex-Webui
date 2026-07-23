### Thread detail load avoids duplicate history fetch and eager resume

#### Feature/Change Name
Opening a thread chooses one bounded history bootstrap from its persisted `historyMode`. Legacy threads use one read without eager resume; paginated threads use one metadata-only resume with an embedded initial turn page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. One completed legacy thread and one completed paginated thread, each with more than 10 turns

#### Steps
1. Open the legacy thread and inspect network/RPC calls until its newest messages render.
2. Confirm opening it performs one `thread/read` with `includeTurns: true` and no `thread/resume`.
3. Send a new message in the legacy thread and inspect the RPC order for the send.
4. Open the paginated thread and inspect network/RPC calls until its newest messages render.
5. Inspect the sole initial `thread/resume` request and response.
6. Send a new message in the paginated thread and confirm the already-materialized thread does not receive a duplicate resume.
7. Reload the paginated thread with its bootstrap `thread/resume` artificially delayed. Send while that bootstrap is still pending, verify the optimistic user row appears immediately, then release the response and inspect the RPC sequence.
8. With the selected thread already loaded, connect or reconnect the notification stream with an initial `ready` event whose replay is available, then inspect its history requests.
9. Delay a selected thread's first history response, emit that initial replay-capable `ready` event while the request is pending, then release the response and inspect the final request count.
10. Keep a different running thread visible only in the sidebar (never open it), emit the same initial `ready` event, and inspect whether that background thread is hydrated.

#### Expected Results
- The legacy initial load performs exactly one `thread/read` with `includeTurns: true`, zero `thread/resume`, and no `/codex-api/thread-live-state` history bootstrap.
- Sending in a legacy thread calls `thread/resume` before `turn/start`; merely opening it never materializes the thread.
- The paginated initial load performs exactly one `thread/resume` with `excludeTurns: true` and `initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" }`.
- A successful paginated bootstrap renders at most 10 newest turns from `initialTurnsPage` without an additional first-page `thread/turns/list` request.
- Sending in that already-resumed paginated thread proceeds to `turn/start` without a second resume.
- Sending during an in-flight paginated bootstrap waits for that same materialization Promise before `turn/start`; it never issues a competing plain `thread/resume({ threadId })`, while the optimistic user message and thinking state remain visible immediately.
- The first replay-capable notification `ready` event refreshes bridge metadata without repeating the already-loaded selected thread's history request.
- If that initial `ready` event arrives during the selected thread's first history request, it reuses the in-flight request and still finishes with exactly one history request.
- An unseen background running thread is not hydrated merely because the notification stream became ready; explicit updates or opening that thread still load it normally.
- Both modes preserve model metadata, active/in-progress state, chronological rendering, and original message identity.

#### Rollback/Cleanup
- Stop only the disposable test server if one was started; do not stop the persistent development server.

---
