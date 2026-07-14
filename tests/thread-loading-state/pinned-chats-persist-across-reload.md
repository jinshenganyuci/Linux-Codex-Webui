# Feature: Pinned chats persist across reload

## Prerequisites / setup

- Start the current checkout on disposable port `4173`.
- Keep at least two chats visible in the sidebar.
- Open browser developer tools and filter network requests by `/codex-api/thread-pins`.

## Actions and expected results

1. Open an unpinned chat menu and click `Pin this chat` / `置顶此聊天`.
   - The chat moves to the `Pinned chats` / `已置顶` section immediately.
   - Exactly one successful `PUT /codex-api/thread-pins` request stores the updated ordered IDs.
2. Reload the page with a hard refresh.
   - `GET /codex-api/thread-pins` restores the same chat and order.
   - Reload does not issue a `PUT` that clears the saved IDs.
   - Reopening the menu shows `Unpin this chat` / `取消置顶`.
3. Temporarily delay the thread list or make the pinned chat absent from the first page.
   - The saved ID is retained while the chat summary is hydrated.
   - A transient list gap never silently deletes the pin.
4. Make `PUT /codex-api/thread-pins` fail, then try to pin or unpin.
   - The optimistic sidebar change rolls back.
   - A visible error is shown instead of silently pretending the action succeeded.
5. Remove the failure, retry, then reload.
   - The final explicit pin/unpin choice remains after reload.
6. Archive a pinned chat from its menu.
   - The explicit archive action removes the saved pin before the chat disappears from the active list.

## Persistence evidence

- The server stores ordered IDs in `$CODEX_HOME/.codex-global-state.json` under `pinned-thread-ids`.
- Pins are removed only by an explicit unpin or archive action, not by partial pagination or temporary thread-list filtering.

## Rollback / cleanup

- Explicitly unpin any chats used by the test.
- Stop only the disposable `4173` process if this test started it.
