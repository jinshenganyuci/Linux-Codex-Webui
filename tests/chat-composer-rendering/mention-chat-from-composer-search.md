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

#### 2026-11-08 Isolated App-Server Acceptance
- Run `node scripts/verify-core-chat-files-isolated.cjs` using a fresh temporary `CODEX_HOME`. A deterministic local provider drives real app-server turns without real account credentials or paid model calls; both WebUI ports are loopback-only.
- The script sends a unique `PR5_TESTCHAT_*` marker through the WebUI. A real persisted assistant row renders `[README.md](README.md)` and an HTTPS link; `hrefOk`, `titleOk`, and `textOk` pass on desktop light and after refresh on phone dark, with no horizontal overflow. Screenshots include `testchat-core-chat-files-light-1440-cjs.png` and `testchat-core-chat-files-dark-375-cjs.png`.
- From the plus-menu chat search, the script selects the TestChat reference and sends `PR5_MENTION_*`. The persisted native user item contains `{ type: "mention", path: "thread://<id>?hostId=local" }`; the rendered chip links to the local WebUI chat and retains the title and reference path. The `testchat-structured-mention-light-1440-cjs.png` screenshot and exact assertions are listed in `output/playwright/core-chat-files-isolated/report.json`.
- This verifies the WebUI/app-server protocol and renderer against a synthetic provider, not ChatGPT authentication or a real model's generated wording. The script stops only its own test listeners and leaves the temporary home for inspection.
