### Feature: Project menu Export Project ZIP share

#### Prerequisites / Setup
- Start the app from a checkout with at least one saved local project root.
- Use a project folder containing a small known file, and ensure generated folders such as `.git`, `node_modules`, `.venv`, `.cache`, `.next`, `.gradle`, `target`, and `__pycache__` may be present for exclusion checks.
- For chat export/import coverage, use an isolated `CODEX_HOME` containing multiple session JSONL files whose `session_meta.payload.cwd` points at the project folder, plus thread rows in `state_5.sqlite` with generated titles and distinct `updated_at` values.
- Open browser developer tools with Network recording enabled. Prepare a writable, disposable import parent containing a selectable test folder directly beneath it; selecting that child makes the app resolve the disposable directory as the import parent.
- For an observable default-name refresh, note the pre-import `Create Project` suggestion and export a project with that suggested name into a different source parent; importing it into the disposable parent should make the next suggestion advance.
- Ensure both light and dark themes are available. If file sharing is tested, use a browser that supports `navigator.share({ files })`; otherwise include the unsupported/blocked fallback check.

#### Actions
1. Open the sidebar project action menu in light theme and verify `Export Project` appears between `Browse files` and automation actions.
2. Clear the Network log, click `Export Project`, and verify exactly one `GET /codex-api/project-zip?cwd=<encoded-project-path>` request starts for the selected project.
3. While the request is in progress, confirm the modal reports `Exporting`, updates its byte progress, and keeps Close, Download, and Share disabled. Attempt to close it and verify the active transfer modal remains open.
4. After the request succeeds, verify the modal reports `Ready`, shows the response filename and final size, and enables Close, Download, and Share.
5. Click `Download`; verify one ZIP is saved with the displayed filename, then inspect its contents and exclusions.
6. Click `Share`. On a supported browser, verify the native share sheet receives that ZIP. If the browser does not support file sharing, verify the inline alert says file sharing is unsupported; if permission is blocked, verify it tells the user to use Download instead. In both cases the ready modal must remain usable and Download must still succeed. Cancelling the native sheet must not show a failure.
7. Close the ready modal. Open a thread action menu for a thread inside the same project, click `Export Project`, and verify it issues one export request for the same project path and prepares the same project ZIP.
8. On the new-thread screen, select the prepared child test folder so its parent is the intended disposable import directory. Click `Import Project` next to `Create Project`, then choose the downloaded archive in the ZIP file picker; no separate destination picker is expected.
9. Verify exactly one `POST /codex-api/project-import?parent=<encoded-parent-path>` request sends the selected file with `Content-Type: application/zip` and returns HTTP 200 with a non-empty `data.path`.
10. While import is running, verify the import action cannot start a second file picker/import. After completion, click `Import Project` again, verify the file picker reopens (proving the guard and prior file value were cleared), then cancel it without starting a second import.
11. Verify the imported destination becomes the selected project path, is pinned in the sidebar, the workspace-root choices refresh, and imported chat threads appear without a page reload. Open `Create Project` and verify its default-name suggestion advances from the value recorded before import, then close it without creating another project.
12. Open at least one imported chat and verify its title, ordering, destination `cwd`, current provider/model, and resumability; verify the known project file exists at the returned destination path.
13. Switch to dark theme and repeat steps 1 through 4. Confirm the modal, progress bar, disabled/enabled actions, filename, and any share fallback alert remain readable.

#### Expected Results
- The project menu contains `Export Project` between `Browse files` and automation actions.
- Each thread menu contains `Export Project` after `Browse files`, exporting that thread's project folder, including projectless chat folders and other local directories.
- Clicking `Export Project` opens a modal, shows progress while the ZIP downloads into a blob, then keeps the modal open with `Download` and `Share` buttons.
- The export flow issues one GET for the chosen project; the modal cannot be dismissed and file actions cannot run until preparation finishes.
- Clicking `Download` saves the prepared ZIP; clicking `Share` invokes the browser file share flow when supported.
- Unsupported sharing reports that the browser cannot share files, permission-blocked sharing directs the user to Download, and both paths leave Download available; user cancellation is silent.
- The archive includes project files under relative paths.
- `.git`, `node_modules`, common language/package cache folders, standard virtualenv folders, build output folders, coverage folders, OS metadata files, and Git-ignored files are not included when export runs inside a Git repo.
- Existing non-chat files under a project's `.codex-project/` folder round-trip through import; chat JSONL files under `.codex-project/chats/` are handled as imported Codex sessions.
- Matching Codex session JSONL files are included under `.codex-project/chats/`.
- Matching thread titles and update timestamps are included under `.codex-project/chats/thread-titles.json`.
- Import creates a new project folder, restores project files, registers the imported project in the sidebar, and writes imported chat sessions into the active `CODEX_HOME` with `cwd` rewritten to the new project folder.
- Import issues one ZIP POST, guards against a duplicate concurrent import, selects and pins the returned path, and refreshes roots, threads, and the default project name without requiring a browser reload.
- Imported chat rows keep the original generated title and source ordering when title metadata is available, and sessions without explicit DB timestamp metadata keep their source JSONL ordering instead of being treated as newly updated.
- Imported chat sessions are rewritten to the destination home's current model and provider so resumed imported threads use the active local configuration.
- The menu item remains readable and aligned in both light and dark themes.

#### Rollback / Cleanup
- Delete any shared/exported ZIP files from the chosen share destination or browser download location.
- Delete the imported project folder and any imported test sessions from the isolated `CODEX_HOME`.
- Restore the previous theme and remove only disposable project/cache fixtures created for this test.
