### Thread message cache skips unchanged refetches

#### Feature/Change Name
Loaded legacy and paginated thread pages are reused when the thread version and history mode have not changed and the thread is not in progress.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. One completed legacy thread and one completed paginated thread

#### Steps
1. Open the completed legacy thread and wait for messages to render.
2. Switch to another thread or home, then return without creating any thread update.
3. Inspect network/RPC calls and visible messages during the return.
4. Repeat steps 1-3 for the completed paginated thread after loading both its initial and one older page.
5. Trigger a real version change in each mode and reopen it.
6. Change a fixture's advertised `historyMode` for the same thread id and reopen it.
7. Load 22 completed threads concurrently, keeping one selected, and then let every response settle. Revisit the selected thread and one of the least-recent inactive threads.
8. Trigger two simultaneous forced refresh causes for the same completed turn (for example completion notification plus terminal runtime reconciliation) and inspect the latest-page requests.

#### Expected Results
- The first open follows the mode-specific bounded bootstrap: one legacy `thread/read`, or one paginated `excludeTurns + initialTurnsPage` resume.
- Returning to an unchanged completed thread displays cached messages immediately without another `thread/read`, `thread/resume`, first-page `thread/turns/list`, or `thread/items/list` request.
- Cached paginated turn/page identity and older cursor remain intact; messages do not duplicate when scrolling resumes.
- A real thread version change or in-progress state refreshes from the correct mode-specific API.
- A `historyMode` change invalidates incompatible messages, cursors, loaded flags, and resume state before loading the new mode.
- Same-key concurrent history requests are coalesced rather than sent twice.
- The LRU retains at most 20 settled thread histories after concurrent requests finish; selected, running, and still-in-flight histories are protected, while the least-recent inactive entry is refetched when revisited.
- Concurrent forced refreshes for the same thread share the already-running forced history request instead of issuing a second identical latest-page load.

#### Rollback/Cleanup
- None

---
