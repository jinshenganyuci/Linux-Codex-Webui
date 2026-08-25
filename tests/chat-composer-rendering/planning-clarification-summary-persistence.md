### Feature: Planning clarification summaries persist after answering

#### Prerequisites

- Start the current worktree on the routine acceptance port (`13511`) or the disposable Playwright port (`4173`).
- Open a thread in Plan mode and use a prompt that causes Codex to call `request_user_input` with two or more questions.
- Have a second browser profile or private window available for cross-browser verification.
- Test once in light theme and once in dark theme; include desktop, `375x812`, and `768x1024` viewports.

#### Steps

1. Wait for the structured clarification form to appear and answer every question.
2. Select **Send** and confirm the editable form leaves the composer area.
3. Confirm a compact **Planning clarification** row remains in the same turn and reports the correct question count and **Answered** status.
4. Expand the row and confirm every question and submitted answer is present; collapse it again and confirm it occupies only one compact row.
5. Refresh the page, wait for the thread history to load, and confirm the same row and answers return without rerunning the prompt.
6. Open the same thread in the second browser profile and confirm the same collapsed row is restored there.
7. Trigger another structured clarification request, interrupt the turn before answering, and confirm a compact **Unanswered** row remains without fabricated answer text.
8. Permanently delete a disposable test thread, then query `/codex-api/request-user-input-history?threadId=<thread-id>` and confirm its data is empty.
9. Repeat steps 1-7 in light and dark themes at desktop, `375x812`, and `768x1024` sizes.

#### Expected Results

- Sending an answer removes only the interactive form; it does not remove the historical record.
- Completed records are collapsed by default, expand on explicit click, and remain readable without displacing the rest of the conversation.
- Questions and non-secret answers survive refresh and a different browser because they are stored by the WebUI backend, not browser storage.
- Interrupted or invalidated forms use **Unanswered** and never look successfully submitted.
- Secret-marked answers are represented as hidden and their plaintext is never written to the history file.
- Each thread retains at most the latest 64 summaries, so repeated questions cannot create unbounded frontend or storage growth.
- The thread loads normally if the supplementary history endpoint is temporarily unavailable.

#### Rollback/Cleanup

- Permanently delete disposable test threads to remove their associated clarification history.
- Stop only the disposable `4173` verification server if one was started; do not stop the persistent `5173` server or alter `13510`.
