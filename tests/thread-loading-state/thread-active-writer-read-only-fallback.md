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
