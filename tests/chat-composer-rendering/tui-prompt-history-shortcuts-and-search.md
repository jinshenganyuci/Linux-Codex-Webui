### Feature: TUI-style prompt history shortcuts and search

#### Prerequisites
- Run the WebUI with a local test chat in an isolated browser profile; keep another browser tab available to check ordinary reload behavior.
- Prepare short, distinct prompts and one unsent multiline draft. Test both light and dark themes.

#### Steps
1. Submit two distinct prompts in the test chat, then focus an empty composer and press Up twice, Down twice.
2. Enter an unsent draft, press Up and then Down, and confirm the unsent draft returns.
3. Type a multiline draft, place the caret on the second line, and press Up; then place it on the first line and press Up.
4. Focus the composer and press Ctrl+R, type a unique word from an earlier prompt, use Up/Down and Enter to restore a result, then reopen search and press Escape.
5. Reload the page and reopen history search; verify the submitted prompts remain in this browser profile. Switch to another browser profile and confirm its history is separate.
6. Repeat the search panel and keyboard flow in both light and dark themes.
7. In a chat with a completed assistant answer, focus the composer and press Ctrl+O while a newer answer is streaming or after it finishes.

#### Expected Results
- Up/Down navigates recent submitted prompt text newest-first without sending; Down restores the unsent draft.
- Multiline editing retains normal caret movement away from the first line. Ctrl+R opens a search panel only while the composer is focused.
- Search is case-insensitive, shows at most 20 results, and Enter restores text without submitting. Escape leaves the current draft untouched.
- History stays in browser-local storage, with at most 100 prompts and 200,000 total characters; it does not read or modify Codex TUI's own history file.
- The search panel is legible in both themes and never creates a new API request.
- Ctrl+O copies the latest completed assistant answer without sending a message or copying partial live text.

#### Automated Verification
- Start the current worktree on `http://127.0.0.1:4173` with an isolated `CODEX_HOME`, then run `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome-stable node scripts/verify-tui-prompt-history.cjs`.
- The script checks 1440×900, 768×1024, and 375×812 in light and dark themes. It also replays a synthetic completed chat for Ctrl+O, verifies clipboard text, and sends no model request.
- Review `output/playwright/tui-prompt-history-report.json` and the `tui-prompt-history-*.png` / `tui-copy-last-response-light-1440.png` screenshots in the same directory.

#### Rollback/Cleanup
- Clear only this test browser profile's `codex-web-local.prompt-history.v1` localStorage key and remove the temporary test chat if no longer needed.
