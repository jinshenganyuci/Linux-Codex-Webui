### Backend-drained queue UI refresh

#### Feature/Change Name
The queue panel refreshes when the backend starts and drains persisted queued messages.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Open a `TestChat` thread
3. Queue at least three short messages while a turn is running
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, confirm queued rows are visible above the composer
2. Let the backend drain each queued message
3. Confirm the queue panel removes each row as its queued turn starts
4. Confirm the queue panel disappears when the final queued message is submitted
5. Refresh the thread after all queued turns complete
6. Switch to dark theme and repeat the visibility check after queue drain
7. Throttle history loading, then watch the first queued item move from queued to sending and finally into the user-message history.
8. Repeat with two identical prompts, attachments, and skills; fail one `turn/start`, reconnect, and retry.
9. Drain 20 short queued messages back-to-back while sampling the queue row and matching user row every 20 ms.

#### Expected Results
- Queued messages execute in order after the active turn completes
- The queue panel reflects backend queue state after `turn/started` and `turn/completed`
- A claimed row remains visible and disabled as `Sending...` until the exact matching `turnId` exists as a persisted user message; there is no blank handoff frame.
- The claimed row is released only after the matching user-message render commit; all 20 rapid handoffs record zero missing frames and zero missing milliseconds.
- Queue ownership is correlated by queue ID and turn ID, so identical text cannot remove or hide the wrong row.
- A failed start restores the same row at its original position, including attachments, skills, model, effort, and speed.
- Reconnect recovery removes only a completed claimed row and preserves the next queued item.
- No already-executed queued rows remain visible after the queue is empty
- Queue row text, actions, and composer spacing remain readable in both light theme and dark theme

#### Rollback/Cleanup
- Delete any remaining queued test messages or let the queue drain

---
