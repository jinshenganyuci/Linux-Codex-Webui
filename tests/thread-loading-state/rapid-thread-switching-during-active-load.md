### Feature: Rapid thread switching during active load

#### Prerequisites
- Start app from this repository (`pnpm run dev`).
- Ensure there are at least 3 existing threads with enough history so opening each triggers a visible loading state; include both legacy and paginated histories.
- Use request interception to delay one `thread/read`, one paginated bootstrap/page request, and one paginated `thread/items/list` completion reconciliation.

#### Steps
1. Open thread A from the sidebar.
2. While thread A is still loading, quickly click thread B and then thread C.
3. Repeat fast switching across multiple threads (for example A -> B -> C -> A) before each load settles.
4. While an older paginated page is loading for A, switch to B and let A's response finish.
5. While completed-turn `thread/items/list` reconciliation is loading for B, switch to C and let B's response finish.
6. Observe selected row highlight, URL route (`/thread/:threadId`), loading indicator, and conversation content after all responses settle.

#### Expected Results
- The final clicked thread is always the selected thread.
- Sidebar highlight, route thread id, and rendered conversation stay in sync.
- A stale response may populate only its own thread cache; it cannot overwrite the selected conversation, history mode, opaque cursor, error, or loading state.
- A previous thread's `finally` handler cannot clear the current thread's loading indicator.
- Repeated selections reuse/coalesce the matching in-flight or fresh cached request instead of producing duplicate `thread/read`, `thread/resume`, `thread/turns/list`, or `thread/items/list` calls for the same key.
- No stale intermediate selection remains after rapid clicks, and no message rows are duplicated after revisiting A or B.

#### Rollback/Cleanup
- No cleanup required.
