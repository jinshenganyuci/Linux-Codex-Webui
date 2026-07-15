### Feature: Dark theme command rows in chat remain readable

#### Prerequisites
- App is running from this repository.
- Open a thread that contains a completed command with known multiline output and an oversized historical command whose rendered output begins with `[较早输出已省略]`.
- Appearance is set to `Dark` in Settings.
- Browser developer tools are available for inspecting the selected command block.

#### Steps
1. Open a thread with one or more command execution rows in the conversation.
2. Verify command label text, grouped command label text, and status text in collapsed rows.
3. Select a collapsed `.command-execution-block` in the Elements panel and run `$0.querySelectorAll('pre.cmd-output').length`; verify it returns `0`.
4. Locate a file-change summary row (for example: `▶ 2 files changed · 2 edited`) and verify the chevron and summary text are readable.
5. Expand the known-output command row. Verify one `pre.cmd-output` is mounted, every known line is present, and the output panel border and text remain readable.
6. Expand the oversized historical command. Verify `[较早输出已省略]` is visible at the start, the unique final line remains visible, and the output can be scrolled without changing the row layout.
7. Collapse both commands and verify their `pre.cmd-output` elements are removed from the DOM.
8. Confirm status colors for running/success/error command rows are distinguishable in dark mode.
9. Toggle to `Light` theme and repeat steps 2 through 7; confirm command rows keep their existing light styling and the full/truncated output semantics do not change with theme.

#### Expected Results
- Command labels and grouped command labels are readable against dark row backgrounds.
- File-change summary rows keep readable chevron and summary text in dark mode.
- Default status text is readable in dark mode.
- Running/success/error status colors remain visible in dark mode.
- Expanded command output border is visible without using a bright light-theme border.
- Light theme command row styling is unchanged.
- Collapsed command rows contain no output `<pre>`; expanding mounts the complete normal output or the explicit historical truncation marker plus retained tail, and collapsing unmounts it again.
- Theme changes affect presentation only and do not alter command output text or expansion state semantics.

#### Rollback/Cleanup
- Return appearance setting to the previous user preference.
- Delete the disposable oversized-output fixture if it was created only for this test.
