### Feature: Long-running conversations keep all loaded messages visible

#### Prerequisites
- App is running from this repository.
- A thread exists with more than 50 messages (send many short messages, or use a long-running session).
- Browser developer tools are available with the Elements and Network panels open.
- The thread contains one completed command with a known output smaller than 256 KiB, including unique first and last lines.
- A separate historical fixture contains a `commandExecution.aggregatedOutput` larger than 256 KiB (262,144 UTF-8 bytes), with unique early and final markers. Reload the thread after creating the fixture so it is read through `thread/read`, `thread/resume`, or the live-state history response rather than only from an in-memory live turn.

#### Steps — loaded-message visibility

1. Open a thread with 60+ messages.
2. Scroll from the newest messages to the first message currently loaded in the conversation.
3. Verify the earlier loaded messages remain present; no loaded message disappears merely because the thread exceeds 50 rows.
4. Verify the latest messages remain visible when the conversation is scrolled back to the bottom.

#### Steps — server-paginated history

5. Scroll up slowly toward the top of the conversation list.
6. If the thread has more persisted history, when the scroll position reaches within ~200 px of the top, verify that the next server history page appears above the current messages.
7. Confirm the viewport does **not** jump — the messages you were reading stay in view.
8. Repeat scrolling up to verify additional server pages load on demand.
9. Once all persisted pages are loaded, confirm reaching the top no longer prepends another page.

#### Steps — live session growth

10. Start an active Codex session (or send many messages in quick succession).
11. Let the conversation exceed 50 messages while staying scrolled to the bottom.
12. Scroll upward during the running task and verify every already loaded message remains readable.
13. Confirm the conversation never leaves a blank gap that only a page refresh can repair.

#### Steps — rollback / message shrink

14. In a thread with a turn that can be rolled back, trigger a rollback.
15. Verify the conversation does **not** go blank — messages still render after the list shrinks.
16. Confirm earlier remaining messages stay accessible after the list shrinks.

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
- All messages currently loaded for the thread remain in the DOM and accessible; there is no 50-message frontend render window.
- Scrolling to the top loads only genuinely older server-paginated history and does not cause a viewport jump.
- During live output, previously loaded messages are never trimmed from the top by the frontend.
- After a rollback the conversation remains visible; no blank screen or blank gap.
- A collapsed command mounts no output `<pre>` or output text; expansion mounts one accessible output region, and collapsing it unmounts the `<pre>` again.
- Command outputs at or below the limit remain complete when expanded.
- Oversized historical command output is bounded to 256 KiB by UTF-8 byte count in the first-paint history response, starts with the omission marker, retains the newest valid UTF-8 tail, and exposes the original byte count and truncation flag.
- Expanding a truncated command loads its complete output on demand once, preserves the truncated tail on failure, caches at most eight complete outputs for the active thread, and clears that cache when the active thread changes.

#### Rollback/Cleanup
- Closing or refreshing the tab does not discard any currently loaded message from the conversation renderer.
- Delete the disposable long-thread and oversized-output fixtures if they were created only for this test; no application preference needs to be restored.
