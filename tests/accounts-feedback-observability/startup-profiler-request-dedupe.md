### Startup profiler request dedupe

#### Feature/Change Name
Startup refreshes reuse fresh in-memory results, and the profiler distinguishes the single expected legacy/paginated history bootstrap from duplicate page requests.

#### Prerequisites/Setup
1. Start local Vite: `pnpm run dev --host 127.0.0.1 --port 4173`.
2. Ensure the browser profiler is available from this repository.
3. Have one non-empty legacy thread and one non-empty paginated thread available.

#### Steps
1. In light theme, run `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser`.
2. Open the generated `output/playwright/browser-runtime-profile-home-*.json`.
3. Confirm `duplicateCounts.threadListFirstPage` is `1`, `duplicateCounts.skillsList` is `1`, and `warnings` is empty.
4. Run `PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_ROUTE='#/thread/<legacy-id>' PROFILE_WAIT_MS=7000 pnpm run profile:browser` and open its JSON report.
5. Confirm the target mode is legacy and `apiRows` contains exactly one matching `thread/read` with `includeTurns: true`, zero matching `thread/resume`, and no duplicated same-key history request.
6. Repeat step 4 with `#/thread/<paginated-id>`.
7. Confirm the paginated report contains one matching `threadResumeCalls` entry with `request.excludeTurns: true`, `request.initialTurnsPage` set to `limit: 10`, `sortDirection: "desc"`, `itemsView: "full"`, and `response.firstPageTurnCount <= 10`.
8. Confirm `duplicateCounts.threadTurnsList*`, `threadItemsList*`, `historyPageDuplicateKeys`, and `duplicateHistoryPageRequests` accurately reflect captured native history traffic. For every continued page, verify the next request `cursor` exactly matches the preceding row's `responseNextCursor` or `responseBackwardsCursor`.
9. Repeat either thread route with `PROFILE_CACHE_REVISIT=true`; inspect the separate `cacheRevisit` section.
10. Repeat the home route in dark theme and confirm the page finishes loading without invalid profiler state.

#### Expected Results
- Startup event bursts do not issue duplicate first-page `thread/list` requests.
- Startup event bursts do not issue duplicate same-cwd `skills/list` requests.
- Pinned-thread summaries may appear as `thread/read:*:summary` rows, but they do not count as the selected legacy history read or trigger duplicate full-read warnings.
- Legacy initial history is one `thread/read` with turns and zero eager resume; paginated initial history is one `excludeTurns + initialTurnsPage` resume with no duplicate first-page `thread/turns/list`.
- Native history duplicates are keyed by method, thread id, turn id (for item pages), and opaque cursor, and appear in both `duplicateHistoryPageRequests` and `warnings` when repeated. Captured rows retain `responseNextCursor`/`responseBackwardsCursor` so opaque cursor propagation can be checked directly.
- For non-empty thread routes, `pageState.firstRealMessageMs` is numeric and uses the real user/assistant `.conversation-item` selector.
- `performance.longTaskCount` and `maxLongTaskMs` are numeric when supported, otherwise explicitly `null`; `measurementScope` states that browser RPC counts cannot prove the absence of app-server internal item-query N+1 work.
- The optional same-context revisit displays messages with zero history API requests and `cacheHitInferred: true` when the cache is valid.
- Light and dark runs have `appShellPresent: true`, `zeroApiTraffic: false`, and `stillLoadingThreads: false`.

#### Rollback/Cleanup
- Stop the temporary Vite server if it was only used for this check.
- Remove generated profiler JSON, screenshot, and trace artifacts when they are no longer needed.

---
