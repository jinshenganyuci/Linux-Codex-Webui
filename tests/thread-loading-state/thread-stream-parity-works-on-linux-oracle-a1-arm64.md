### Feature: Bounded thread history parity works on Linux (Oracle A1 ARM64)

#### Prerequisites/Setup
- Oracle A1 server accessible via SSH (`ssh a1`).
- A current Codex CLI with `historyMode`, `thread/turns/list`, and `thread/items/list` support installed on A1.
- Existing legacy and paginated Codex sessions containing commands and file edits on A1.
- The current checkout is available in `~/codexui`; Mac can reach its disposable server through Tailscale.

#### Steps
1. Start the current checkout on A1 with `pnpm run dev --host 0.0.0.0 --port 4173` and retain the exact process id.
2. Call `thread/list` locally, choose one thread of each `historyMode`, and record their ids.
3. Call `thread/read` with `includeTurns: true` for the legacy thread and inspect its bounded turns/items.
4. Call `thread/resume` for the paginated thread with `excludeTurns: true` and `initialTurnsPage: { "limit": 10, "sortDirection": "desc", "itemsView": "full" }`.
5. Pass the returned opaque older cursor unchanged to `thread/turns/list`, then verify the descending page renders chronologically in the WebUI.
6. Complete a disposable paginated turn and verify `thread/items/list` reconciles its command/file-change items by `turnId`.
7. For both modes, verify `commandExecution` items have correct `command`, `status`, and bounded `aggregatedOutput`; verify `fileChange` items preserve `changes[].path`, `operation`, and `diff`.
8. Verify commands and file changes remain interleaved chronologically with agent messages rather than being appended as a separate block.
9. From Mac, open `http://<A1-Tailscale-IP>:4173/#/thread/<id>` for each mode and repeat initial-load plus one older-page check.

#### Expected Results
- The bridge starts and spawns Codex app-server on Linux ARM64 without errors.
- The legacy first paint uses one bounded `thread/read` and zero eager resume; older turns load on demand.
- The paginated first paint uses one metadata-only resume with at most 10 embedded turns; older turns use native opaque cursors.
- A completed paginated turn reconciles through `thread/items/list` without a whole-history read.
- Session-log recovery and inline-payload sanitization work for both history envelopes with Linux paths such as `/home/ubuntu/.codex/sessions/...`.
- Stable `turnId + item.id` identity prevents duplicates while preserving chronological command, file-change, agent-message, and child-agent rows.
- Mac/Tailscale access displays the same bounded history and on-demand pagination behavior as local A1 access.

#### Historical Baseline (2026-04-08)
- Ubuntu ARM64 with Node v22.22.0 and Codex CLI 0.101.0 recovered commands/file changes from three legacy sessions.
- Those source sessions contained 21/10/4 turns, 120/62/73 commands, and 17/3/7 file changes respectively.
- These figures remain recovery-content evidence only; they are not an expectation that the current first-paint response returns every source turn.

#### Rollback/Cleanup
- Stop only the recorded disposable `4173` process started in step 1.
- Remove disposable paginated turns and any temporary interception fixtures; do not stop unrelated Vite or formal console services.
