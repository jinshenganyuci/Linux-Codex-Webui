### Feature: Thread protocol parity with bounded legacy and paginated history

#### Prerequisites/Setup
- App is running from this repository on disposable port `4173`.
- One legacy thread and one paginated thread each contain more than 10 persisted turns.
- The paginated thread can run a disposable turn containing agent messages, commands, file changes, and a child-agent result.
- Browser Network tools are recording RPC bodies and notification frames.

#### Steps
1. Inspect `thread/list` and confirm both fixtures advertise their real `historyMode`.
2. Open the legacy thread and record its initial history request.
3. Open the paginated thread and inspect the initial `thread/resume` request plus `initialTurnsPage`, `turnsBackwardsCursor`, and `itemsBackwardsCursor` response fields.
4. Scroll to the top once and confirm `thread/turns/list` receives the exact opaque older cursor returned by the bootstrap page.
5. In the paginated thread, run the disposable turn and observe live notification rows while it is active.
6. When `turn/completed` arrives, inspect `thread/items/list`: its first request identifies that completed `turnId`, uses `cursor: null`, `limit: 100`, and `sortDirection: "asc"`.
7. If the items response returns `nextCursor`, confirm each following request passes that exact opaque cursor until null; use no more than four item pages for this fixture.
8. Compare the completed turn before and after reconciliation, including user, agent, command, file-change, and child-agent result rows.
9. Fetch `/codex-api/thread-stream-events?threadId=<id>&limit=50` and confirm active buffered frames remain available for live recovery rather than serving as the persisted-history bootstrap.
10. Simulate an explicit `thread/items/list` method-not-found response, complete another paginated turn, and confirm the UI falls back to a bounded paginated page refresh without switching to legacy full-history loading.

#### Expected Results
- A legacy initial open uses exactly one bounded `thread/read` with turns and zero eager `thread/resume`.
- A paginated initial open uses exactly one `thread/resume` with `excludeTurns: true` and `initialTurnsPage: { limit: 10, sortDirection: "desc", itemsView: "full" }`; it never loads all history through `/codex-api/thread-live-state`.
- Older paginated history uses `thread/turns/list`; cursors remain opaque and descending pages render chronologically without duplicate `turnId + item.id` identities.
- `turn/completed` reconciles only that paginated turn through `thread/items/list` and does not issue a whole-thread `thread/read` or redundant `thread/resume` when item pagination succeeds.
- Completed-turn reconciliation replaces incomplete live rows without removing the optimistic user row, duplicating commands/results, or leaking background-thread output into the selected thread.
- Persisted item types remain backend-authored (`userMessage`, `agentMessage`, `commandExecution`, `fileChange`, child-agent items, and related protocol items); assistant prose does not fabricate file changes.
- Live command executions retain their `turnId`, commands stay interleaved with agent messages, and file changes retain their real diff/kind data.
- Stream-event recovery remains bounded and separate from persisted-history pagination.
- An explicitly unsupported `thread/items/list` capability is remembered and falls back safely; unrelated transport or server failures remain visible and retryable rather than being treated as unsupported.

#### Rollback/Cleanup
- Stop only the disposable `4173` server if this test started it.
- Remove or archive the disposable legacy/paginated threads and clear request-interception rules.
