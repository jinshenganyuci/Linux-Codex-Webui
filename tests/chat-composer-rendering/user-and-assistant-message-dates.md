# User and assistant message dates

## Feature/Change Name

Every user message and assistant reply shows its local date and time below the message. Historical legacy and native-paginated turns use the Codex turn timestamps; a newly sent or streaming message shows a date immediately and is reconciled with the persisted turn after completion.

## Prerequisites/Setup

1. Run the WebUI from this repository with an authenticated Codex CLI.
2. Have one existing completed thread and create one new thread for the live-message check.
3. Make both light and dark themes available; include a `375x812` mobile viewport.

## Steps

1. Open an existing completed thread and confirm each visible user message and assistant reply has a `YYYY-MM-DD HH:mm` label beneath it.
2. Refresh the page and confirm the same labels remain visible rather than being replaced with the refresh time.
3. Start a new thread, send a unique short marker, and confirm its user row and date appear immediately.
4. Wait for the assistant reply and confirm it has its own date below the reply.
5. Repeat the existing-thread and new-thread checks in dark theme and at the mobile viewport.

## Expected Results

- User messages use their real turn start time; completed assistant replies use their real turn completion time.
- A just-sent user message is timestamped immediately and does not duplicate after history reconciliation.
- Assistant text, plan cards, and generated images receive a date when they appear live and remain readable after completion.
- Command rows, file-change summaries, progress cards, and system notices do not gain unrelated date labels.
- The labels are readable in light and dark themes, do not overlap controls, and preserve normal message alignment on desktop and mobile.

## Rollback/Cleanup

- Stop only any disposable local test server started for this check.
- Archive or delete the disposable test thread if it is no longer needed.
