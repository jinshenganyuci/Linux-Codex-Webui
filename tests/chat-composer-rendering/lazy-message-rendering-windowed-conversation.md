### Feature: Lazy message rendering (windowed conversation)

#### Prerequisites
- App is running from this repository.
- A thread exists with more than 50 messages (send many short messages, or use a long-running session).
- Browser developer tools are available with the Elements and Network panels open.
- The thread contains one completed command with a known output smaller than 256 KiB, including unique first and last lines.
- A separate historical fixture contains a `commandExecution.aggregatedOutput` larger than 256 KiB (262,144 UTF-8 bytes), with unique early and final markers. Reload the thread after creating the fixture so it is read through `thread/read`, `thread/resume`, or the live-state history response rather than only from an in-memory live turn.

#### Steps — initial load window

1. Open a thread with 60+ messages.
2. Observe that the conversation list does **not** show all messages immediately — only the most recent ~50 are rendered.
3. Verify the latest messages are visible and the chat is scrolled to the bottom.
4. Confirm no persistent older-message button appears at the top of the visible list.

#### Steps — scroll-triggered load

5. Scroll up slowly toward the top of the conversation list.
6. When the scroll position reaches within ~200 px of the top, verify that the previous 30 messages appear automatically above the current ones.
7. Confirm the viewport does **not** jump — the messages you were reading stay in view.
8. Repeat scrolling up to verify additional chunks load on demand.
9. Once all messages are loaded, confirm reaching the top no longer prepends another batch.

#### Steps — live session growth

10. Start an active Codex session (or send many messages in quick succession).
11. Let the conversation exceed 50 messages while staying scrolled to the bottom.
12. Verify the rendered count stays bounded (top of the DOM list advances as new messages arrive).
13. Scroll up to the top and confirm older trimmed messages load automatically.

#### Steps — rollback / message shrink

14. In a thread with a turn that can be rolled back, trigger a rollback.
15. Verify the conversation does **not** go blank — messages still render after the list shrinks.
16. Confirm `renderWindowStart` recovers gracefully and earlier messages remain accessible.

#### Steps — collapsed command output and historical payload limit

17. Reload the thread, leave the known-output command collapsed, and select its `.command-execution-block` in the Elements panel.
18. Confirm the block contains no `pre.cmd-output` element. As an exact console check, run `$0.querySelectorAll('pre.cmd-output').length` with the block selected and verify the result is `0`.
19. Expand the known-output command and rerun the same check; verify the result is `1`, and verify the `<pre>` contains the complete first line, intermediate text, and final line without an omission marker.
20. Collapse the command again and verify its `pre.cmd-output` is removed from the DOM, not merely hidden with CSS.
21. Reload the oversized historical fixture while recording Network traffic. Inspect the relevant history response and locate the oversized `commandExecution` item.
22. Verify that item has `aggregatedOutputTruncated: true`, `aggregatedOutputOriginalBytes` greater than `262144`, and `aggregatedOutput` beginning with `[较早输出已省略]\n` while retaining the fixture's unique final marker.
23. Expand that command while recording Network traffic. Verify exactly one `POST /codex-api/thread-command-output` request is sent for its `threadId`, `turnId`, and `itemId`; then select its `pre.cmd-output` after the request completes and run:
    ```js
    ({
      byteLength: new TextEncoder().encode($0.textContent ?? '').byteLength,
      markerRemoved: !($0.textContent ?? '').startsWith('[较早输出已省略]\n'),
      tailOk: ($0.textContent ?? '').includes('<unique-final-marker>'),
      earlyTextRestored: ($0.textContent ?? '').includes('<unique-early-marker>'),
    })
    ```
24. Verify `byteLength` equals the original full output size (and is greater than `262144` for this fixture) and all three Boolean checks are `true`. Collapse and reopen it, confirm no duplicate full-output request is made and the complete output remains available, then collapse it and confirm the `<pre>` is removed again.
25. Make the full-output request fail once (for example with a local request override), expand a freshly loaded truncated command, and confirm the truncated tail remains visible instead of becoming blank. Switch to another thread and return to confirm the per-thread full-output cache was cleared.

#### Expected Results
- Only ≤50 messages are in the DOM on initial load.
- Scrolling to the top appends older messages without a viewport jump; no persistent older-message button is shown.
- During live output, the rendered window stays bounded; old messages are trimmed from the top while the user follows the bottom.
- After a rollback the conversation remains visible; no blank screen.
- A collapsed command mounts no output `<pre>` or output text; expansion mounts one accessible output region, and collapsing it unmounts the `<pre>` again.
- Command outputs at or below the limit remain complete when expanded.
- Oversized historical command output is bounded to 256 KiB by UTF-8 byte count in the first-paint history response, starts with the omission marker, retains the newest valid UTF-8 tail, and exposes the original byte count and truncation flag.
- Expanding a truncated command loads its complete output on demand once, preserves the truncated tail on failure, caches at most eight complete outputs for the active thread, and clears that cache when the active thread changes.

#### Rollback/Cleanup
- Closing or refreshing the tab resets the render window.
- Delete the disposable long-thread and oversized-output fixtures if they were created only for this test; no application preference needs to be restored.
