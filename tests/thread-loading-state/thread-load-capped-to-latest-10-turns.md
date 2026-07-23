### Feature: Thread load capped to latest 10 turns

#### Prerequisites
- App is running from this repository.
- One legacy thread and one paginated thread exist with more than 10 turns.
- At least one fetched page contains three `commandExecution` items whose UTF-8 `aggregatedOutput` values each exceed 256 KiB and end with distinct markers, so the per-item and per-response budgets can both be checked.

#### Steps
1. Open the long legacy thread, immediately switch to another thread, then return.
2. Inspect the selected legacy `thread/read` response and its command items.
3. Open the long paginated thread and inspect the `thread/resume` request and `initialTurnsPage` response.
4. Scroll to load one older paginated `thread/turns/list` page.
5. Complete a paginated turn that contains oversized command output and inspect the corresponding `thread/items/list` page.
6. For every oversized command item returned by `thread/read`, `thread/resume.initialTurnsPage`, `thread/turns/list`, or `thread/items/list`, inspect the truncation fields and retained output suffix.
7. Sum the UTF-8 byte lengths of all returned `commandExecution.aggregatedOutput` strings in each individual history response. Confirm which outputs are retained when the page is requested once with ascending order and once with descending order.
8. Expand one truncated command in the WebUI and inspect the explicit `POST /codex-api/thread-command-output` response.

#### Expected Results
- Both history modes initially render at most the newest 10 turns.
- UI remains responsive during thread load.
- You can switch to another thread without the UI freezing.
- Legacy `thread/read` returns at most 10 turns and opening it does not call `thread/resume`.
- Paginated `thread/resume` requests `excludeTurns: true` plus an initial 10-turn descending/full page; native `thread/turns/list` pages preserve their own bounded page data and cursors rather than being re-trimmed as legacy history.
- Every oversized `commandExecution` is limited independently to 256 KiB across all four response envelopes, has `aggregatedOutputTruncated: true`, and reports `aggregatedOutputOriginalBytes > 262144`. Items that still receive response budget begin with `[较早输出已省略]\n` and retain their unique final marker without broken UTF-8 text; a budget-exhausted older item may instead have an empty output.
- All command outputs in one history response consume a shared maximum of 512 KiB. The newest commands consume that budget first according to the request's real `sortDirection`; older commands may retain a shorter tail or an empty payload with truncation metadata after the budget is exhausted.
- Expanding a truncated command performs exactly one coalesced full-output request for its `threadId + turnId + itemId`, replaces the truncated tail with the original complete output, and keeps at most eight full outputs cached for the active thread. Switching threads clears that cache. A failed full-output request leaves the safe truncated tail visible.
- The byte cap does not alter turn/page order, `nextCursor`, `backwardsCursor`, item ids, or non-command items.

#### Rollback/Cleanup
- Remove the disposable oversized-output threads or fixtures if they were created only for this test.
