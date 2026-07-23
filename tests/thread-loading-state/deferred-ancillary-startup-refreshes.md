### Feature: Deferred ancillary startup refreshes

#### Prerequisites
- App is running from this repository.
- One non-empty legacy thread and one non-empty paginated thread are available in the sidebar.
- Browser runtime profiler can run with Playwright from this repository.

#### Steps
1. Run `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_ROUTE="#/thread/<legacy-id>" PROFILE_WAIT_MS=7000 pnpm run profile:browser`.
2. Open the generated JSON report and inspect `pageState`, `historyMode.target`, `duplicateCounts`, `duplicateHistoryPageRequests`, `threadResumeCalls`, `warnings`, `totalApiKB`, `apiSummary`, `slowestApiRows`, and `performance`.
3. Repeat for `#/thread/<paginated-id>`.
4. Confirm each thread's messages appear before non-critical skills, model, account, and collaboration metadata finishes refreshing.
5. Optionally rerun either route with `PROFILE_CACHE_REVISIT=true` to exercise same-context cache reuse without changing the profiler's default run.

#### Expected Results
- The legacy report infers `historyMode.target.inferred: "legacy"`, records exactly one selected-thread `thread/read` with turns, and records zero selected-thread `thread/resume` calls.
- The paginated report infers `historyMode.target.inferred: "paginated"` and records exactly one selected-thread resume whose request has `excludeTurns: true`, `limit: 10`, `sortDirection: "desc"`, and `itemsView: "full"`; its response reports no more than 10 first-page turns.
- The embedded paginated bootstrap does not issue a duplicate first-page `thread/turns/list` request.
- `duplicateCounts.historyPageDuplicateKeys`, `threadReadDuplicateKeys`, and unexpected duplicate-load warnings remain zero. Item-page duplicate identities include `turnId`, so first pages for two different turns are not falsely reported as duplicates.
- Every native page row records the opaque request `cursor` plus `responseNextCursor`/`responseBackwardsCursor`; each subsequent request uses the prior response's matching opaque cursor exactly once.
- `pageState.appShellPresent` is true, `zeroApiTraffic` and `stillLoadingThreads` are false, and `firstRealMessageMs` is non-null for each non-empty thread.
- `performance.longTaskCount` and `maxLongTaskMs` are numeric when Chromium supports Long Tasks, or explicitly `null` when unsupported. No history-load Long Task should exceed approximately 100 ms on the local acceptance host.
- `warnings` contains no history/request-duplication warning, `totalApiKB` stays below the profiler's 750 KiB warning threshold, and `apiSummary`/`slowestApiRows` show no duplicate or unbounded history fanout.
- Direct thread-route hydration has one owner and does not trigger duplicate selected-thread message loads from route watchers.
- Thread history loading is not blocked by waiting for `skills/list`, `account/rateLimits/read`, or `collaborationMode/list`.
- Skills, model metadata, rate limits, and collaboration modes still populate shortly after the thread is visible.
- An optional cache revisit renders messages without another history `thread/read`, `thread/resume`, `thread/turns/list`, or `thread/items/list` request, reports `cacheHitInferred: true`, and should restore the first real message in roughly 250 ms or less on the local acceptance host.

#### Rollback/Cleanup
- Remove generated `output/playwright/browser-runtime-profile-*` artifacts if they are not needed for comparison evidence.
