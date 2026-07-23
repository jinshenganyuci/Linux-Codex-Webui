### Sent user messages are visible immediately in new and existing chats

#### Feature/Change Name
New- and existing-thread sends render the submitted user message and thinking state immediately, without waiting for thread creation, resume, or start-turn requests.

#### Prerequisites/Setup
1. Create a fresh isolated `CODEX_HOME` with valid Codex auth.
2. Start local Vite: `CODEX_HOME=<temp-home> pnpm run dev --host 127.0.0.1 --port 4173`.
3. Use an explicit test project folder plus one legacy and one paginated existing thread.
4. Configure request interception or a local proxy to delay `/codex-api/thread/start-turn`, legacy send-time resume, and direct `turn/start` by two seconds without delaying the optimistic UI itself.

#### Steps
1. In light theme, open `http://127.0.0.1:4173/?openProjectPath=<encoded-test-project-path>`.
2. Send the unique marker `optimistic-new-<timestamp>` in a new chat.
3. During the artificial two-second request delay, confirm the conversation already shows the marker and the thinking/main-model UI directly below it.
4. After the backend returns, confirm navigation reaches the real thread and the marker appears exactly once.
5. Open the legacy thread, confirm its history loaded through one read and zero eager resumes, then send `optimistic-legacy-<timestamp>`.
6. During the artificial send-time resume/start-turn delay, confirm the marker and thinking/main-model UI are both visible; the status UI must not appear by itself above a missing user message.
7. Open the paginated thread, confirm its bounded initial resume has completed, then send `optimistic-paginated-<timestamp>` while delaying `turn/start`.
8. Confirm the paginated marker appears immediately and sending does not issue a second `thread/resume` for the already-materialized thread.
9. While a turn is running, send a steer message and confirm its user row appears immediately. Switch to queue mode for another message and confirm it remains only in the queue panel.
10. Repeat new, legacy, and paginated sends in dark theme and at a `375x812` mobile viewport.

#### Expected Results
- Every non-queued submitted user message appears on the next rendered frame after send.
- Thinking/main-model status is shown directly below the submitted message and never appears first on its own.
- Backend refreshes that contain only the assistant item do not temporarily remove the optimistic user row.
- When the backend later returns the real user item, the optimistic row is replaced without a duplicate.
- Legacy send resumes only when needed before `turn/start`; paginated send reuses its initial materialization and does not duplicate resume work.
- Completion events refresh/reconcile the selected thread even when it was already marked loaded by an optimistic first message; paginated `thread/items/list` reconciliation does not temporarily remove that row.
- Failed thread creation keeps the submitted user text visible with an error instead of silently discarding it.
- Queue-mode messages remain in the queue and tool-input replies retain their existing request-response behavior.
- Light and dark theme message rows remain readable.

#### Rollback/Cleanup
- Stop the temporary Vite server.
- Remove the temporary isolated `CODEX_HOME` and test project folder.
- Remove the request delay/interception rule.
- Archive/delete disposable legacy and paginated test threads if they were created for this case.

---
