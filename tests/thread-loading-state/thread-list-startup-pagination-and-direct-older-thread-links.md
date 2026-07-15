### Thread list startup pagination and direct older-thread links

#### Feature/Change Name
Thread loading uses a smaller initial list page, hydrates later pages in the background, and direct thread URLs are not rejected just because the thread is outside the first page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`).
2. Browser developer tools Network panel open with `Preserve log` enabled; clear the log immediately before the test.
3. More than 150 existing threads, including a known valid thread outside the first 50 and a second known thread outside the first 150.
4. Record both older thread ids and titles before starting. Ensure no turn is actively running for the initial pagination check.

#### Steps
1. Open the app home route and filter Network requests by RPC payload method `thread/list`.
2. Inspect the first `thread/list` request body. Verify `archived` is `false`, `limit` is `50`, and `cursor` is `null`.
3. Wait 9 seconds without using a force-refresh action. Verify the startup window contains exactly one request for `(cursor: null, limit: 50)` and no duplicate first-page request is in flight.
4. Keep the app open for at least 22 seconds. Inspect each later `thread/list` request in order: each uses `limit: 100`, and its `cursor` exactly equals the non-null `nextCursor` returned by the preceding page.
5. Group the recorded requests by `(cursor, limit)` and verify every pair occurs once, no two background `thread/list` requests overlap, and pagination stops when the response returns `nextCursor: null`.
6. Verify the sidebar gains the known thread titles as their pages complete, contains each thread only once, and preserves descending recency order across merged pages.
7. Open a fresh browser page/context so no in-memory thread list is retained, clear its Network log, and navigate directly to `/#/thread/<older-thread-id>` for a valid thread outside the first 50 without first visiting Home.
8. Verify the route remains on that id, its messages load through a thread detail request, and it is not redirected to Home merely because the first page did not contain it.
9. In a separate run, start a disposable turn and reload while it is active. After the first-page response supplies a non-null `nextCursor`, wait more than 10 seconds and verify no background cursor request is issued during the active turn. Stop or complete the turn, then verify the retained next cursor is requested exactly once.

#### Expected Results
- The first `thread/list` request uses `limit: 50`, and concurrent/repeated non-forced startup consumers coalesce or reuse the recent result instead of issuing duplicate first-page requests.
- Later pages load serially in the background with `limit: 100`, using each returned `nextCursor` exactly once until `null`.
- The sidebar gains older threads as pages complete without duplicate rows and remains sorted by recency.
- Background pagination pauses while a turn is active and resumes once with the retained cursor after the active work ends.
- A direct older-thread URL stays on the requested route and loads messages instead of redirecting Home.

#### Rollback/Cleanup
- Stop or complete any disposable active turn used for the pause/resume check.
- Delete only test threads created to exceed the page boundaries; otherwise no persistent state is changed.

---
