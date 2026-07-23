### Thread conversation loads earlier turns on demand

#### Feature/Change Name
Thread conversation incremental older-turn loading.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. One legacy thread and one paginated thread with more than 20 turns are available
3. Light theme and dark theme both available from the appearance switcher
4. Browser Network tools are recording RPC request and response bodies

#### Steps
1. In light theme, open the legacy thread and confirm the newest messages render first.
2. Scroll to the top repeatedly until all legacy pages have loaded; inspect each older-history request.
3. Open the paginated thread and record the opaque `nextCursor` from `thread/resume.initialTurnsPage`.
4. Scroll to the top and inspect the next `thread/turns/list` request and response.
5. Repeat step 4 through at least two non-null cursors, then continue until `nextCursor` is null.
6. During each prepend, keep one visible message near the top as an anchor and verify the viewport remains near that content.
7. Quickly switch away while an older-page request is pending, then return to the paginated thread and continue scrolling.
8. Confirm the oldest messages are visible once and chronological order is preserved.
9. Switch to dark theme and repeat the initial open plus one older-page prepend for each history mode.

#### Expected Results
- Initial thread open remains bounded to the latest turn page.
- Legacy top-scroll loading uses the existing bridge/before-turn identity path and does not introduce native cursor assumptions.
- Paginated top-scroll loading calls `thread/turns/list` with `limit: 10`, `sortDirection: "desc"`, `itemsView: "full"`, and the exact opaque cursor returned by the preceding response; the client never derives, increments, or replaces that cursor with a turn index/id.
- Descending pages are reversed for chronological rendering, then deduplicated by stable `turnId` and item id.
- A repeated cursor is not requested twice, and pagination stops at `nextCursor: null`.
- No persistent older-message control is rendered while older persisted turns exist.
- Prepended pages preserve the user's scroll anchor; delayed pages from a thread that is no longer selected do not overwrite the current conversation or its loading state.
- Message ordering and supported turn actions remain stable in light and dark themes.

#### Rollback/Cleanup
- None.

---
