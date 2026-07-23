### Thread conversation loads earlier turns on demand

#### Feature/Change Name
Thread conversation incremental older-turn loading.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. A thread with more than 10 turns is available
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open a thread that has more than 10 turns.
2. Confirm the newest messages render first and no persistent older-message control appears above the conversation.
3. Scroll to the top of the conversation list.
4. Confirm an older batch is prepended above the previously first visible turn and the scroll position stays near the same content.
5. Continue scrolling to the top until the first turn is loaded.
6. Confirm the oldest messages in the thread are visible and no duplicate message rows are introduced.
7. Switch to dark theme and repeat steps 1-6 on the same thread or another long thread.

#### Expected Results
- Initial thread open remains bounded to the latest turn page.
- Reaching the top fetches older persisted turns from the local bridge instead of only revealing already-loaded messages.
- No persistent older-message control is rendered while older persisted turns exist.
- Message ordering, turn actions, and scroll restoration remain stable in light and dark themes.

#### Rollback/Cleanup
- None.

---
