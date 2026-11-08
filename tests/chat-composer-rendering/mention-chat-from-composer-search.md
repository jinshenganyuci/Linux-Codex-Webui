### Feature: Mention an existing chat from composer search

#### Prerequisites
- Run the app with at least two loaded, active chats. Give one a distinctive title.
- Use an app-server version that supports `UserInput.type = "mention"`.
- Have light and dark themes available.

#### Steps
1. Open a new or existing chat, select the composer `+` button, then choose `Search files and chats`.
2. Type the distinctive chat title and verify a chat result appears with its project name.
3. Select the chat with Enter or the pointer and confirm a removable chat-reference chip appears without sending the draft.
4. Add a short request, refresh the page, and confirm the unsent reference is restored; then send it.
5. Inspect the resulting user message and open the reference chip to verify it routes to the referenced local chat.
6. Repeat the search without a selected project and confirm chat results remain available.
7. Repeat the composer and sent-message checks in both light and dark themes.

#### Expected Results
- Search covers loaded chats across project groups, ranks exact titles first, and limits chat suggestions to eight.
- Selecting a chat produces a `thread://<id>?hostId=local` reference, not a navigation or duplicate file attachment.
- The turn input contains a structured `{ type: "mention", name, path }` block; queued turns preserve the same reference.
- The reference survives draft refresh and thread history loading, with no raw or unhandled JSON block shown.
- Search, reference chips, and result states remain readable in both themes.

#### Rollback/Cleanup
- Remove unsent reference chips and clear the draft. Archive any temporary test chat created for this check.
