### Feature: Read thread history when another app-server owns the writer

#### Prerequisites
- Use a temporary `CODEX_HOME` with a paginated-history thread containing persisted turns.
- Start two independent Codex app-server clients against that home.
- Keep the thread resumed or actively running in the first client.

#### Steps
1. Open the same thread through a direct WebUI `#/thread/<id>` URL in the second client.
2. Inspect the conversation and network requests after loading settles.
3. Force a thread refresh while the first client still owns the writer.
4. Attempt to send a message from the second client without closing the first.
5. Release the first client's writer, reload the WebUI thread, and try sending again.
6. Repeat the history check in light and dark themes.

#### Expected Results
- A paginated `thread/resume` active-writer conflict falls back to legacy `thread/read`; persisted history appears instead of a blank conversation with a fatal 502 card.
- Forced refreshes do not repeatedly call `thread/resume` while this page knows another writer owns the thread.
- Sending while the writer is still held may fail, but the existing history stays visible.
- After the other writer is released and the page is reloaded, normal resume and sending can proceed.
- The conversation remains readable in both themes.

#### Rollback/Cleanup
- Close the extra app-server client and remove the temporary `CODEX_HOME` after confirming no test data is needed.

#### 2026-11-08 Isolated App-Server Acceptance
- Run `node scripts/verify-core-chat-files-isolated.cjs` from the current worktree. The script creates a private temporary `CODEX_HOME` and TestChat, uses `codex-cli 0.167.0` with a deterministic local Responses provider, and binds its two WebUI clients and provider to loopback ports `4182`, `4183`, and `4184` only. It does not use real credentials or a paid model.
- The second app-server returned HTTP 502 with `already has an active writer`. Its browser loaded persisted history through one failed `thread/resume` followed by one full `thread/read`; same-page revisit made no additional resume attempt. Sending while locked showed the error, retained the draft and existing history, and made no provider request. After the first client stopped, the second resumed and completed one new turn.
- Twelve 120 KB synthetic replies produced a 1,207,768-byte bounded history response containing the latest 10 turns. The loopback Vite browser profiler recorded one resume, one full read, zero duplicate history keys, 1,255.3 KiB total API payload, and zero history requests on a same-page cache revisit. First visible message took 1,918.4 ms in this development-server run; the full read took 586 ms. `skillsList=2` remains an unrelated duplicate-request warning; the payload-size warning is expected from the synthetic large history. These numbers are not a production or real-model latency guarantee.
- The report, screenshots, profiler JSON and trace paths are recorded in `output/playwright/core-chat-files-isolated/report.json`. Test listeners are closed after the run; the generated temporary home is retained for inspection until explicitly cleaned up.
