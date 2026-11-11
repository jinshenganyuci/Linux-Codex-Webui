### Feature: Search project files from the attachment menu

#### Prerequisites
- Run the app with a local project selected and at least two searchable files, such as `package.json` and `src/main.ts`.
- Have both light and dark themes available.

#### Steps
1. Open a new or existing chat in the project and select the composer `+` button.
2. Select `Search files and chats`, enter `package.json`, and wait for results.
3. Use the arrow keys to highlight the file result and press Enter to attach it; remove the resulting chip.
4. Repeat the search and click a result with the pointer.
5. Reopen the search, press Escape, and verify the attachment menu returns; click outside to close it.
6. Type `@package` in the composer and verify the existing mention suggestions still work.
7. Repeat the menu and result checks in light and dark themes, then open a chat without a selected project.

#### Expected Results
- Search stays scoped to the selected project and returns file names with their relative directories.
- Opening search without typing does not issue a file-search request; a settled query issues one debounced request and shows at most 20 results.
- Selection attaches one file chip without sending the chat or changing existing draft text.
- Escape, outside click, and project changes close stale search results; without a project, the search stays available for chats but makes no file-search request.
- Search input, results, focus state, and empty/error messages remain readable in both themes.

#### Rollback/Cleanup
- Remove test file chips and clear any unsent draft. No chat turn needs to be created.

#### Automated Verification
- On an isolated `4173` service with a test project labeled `TUI File Search Test`, run `FILE_SEARCH_TEST_PROJECT_LABEL='TUI File Search Test' PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome-stable node scripts/verify-composer-file-search.cjs`.
- The script checks desktop light and phone dark search results, one debounced request per query, file-chip attachment, no horizontal overflow, and no page errors. Reports and screenshots are saved under `output/playwright/tui-file-search-*`.
