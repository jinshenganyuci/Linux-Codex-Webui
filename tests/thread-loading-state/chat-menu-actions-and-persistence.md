# Feature: Chat menu actions and persistence

## Prerequisites / setup

- Start the current checkout on disposable port `4173`.
- Prepare one disposable chat and one disposable project.
- Allow clipboard access and browser downloads for the test origin.

## Actions and expected results

| Menu action | Action | Expected result | Reload persistence |
| --- | --- | --- | --- |
| Add automation… | Create a named automation for the chat, close the dialog, then reopen it. | The saved automation appears in the dialog and the chat shows its automation indicator. | Must persist through the automation API and remain after reload. |
| Browse files | Click the action for a project chat. | A local file-browser page opens for that chat's `cwd`. | One-shot navigation; no persistent UI state is expected. |
| Export project | Click the action and accept the download. | A project ZIP download starts and contains the selected project. | One-shot download; no persistent UI state is expected. |
| Copy path | Click the action, then paste into a text field. | The chat working-directory path is in the clipboard. | Clipboard action only. |
| Copy chat | Select the chat, open its menu, click the action, then paste. | Markdown for the selected conversation is in the clipboard; the item stays disabled for a non-selected chat. | Clipboard action only. |
| Create chat fork | Fork a disposable chat. | A new forked chat is created and selected. | The fork remains in the thread list after reload. |
| Pin this chat | Pin, reload, then reopen the same menu. | The chat remains under `Pinned chats`; the menu changes to `Unpin this chat`. | Must persist through `/codex-api/thread-pins`. |
| Rename thread | Rename the disposable chat. | Sidebar and conversation heading use the new title. | The title remains after reload. |
| Archive chat | Archive the disposable chat. | It leaves the active sidebar and appears in archived conversations. | Archive state remains after reload; an existing pin is explicitly removed. |
| Delete permanently | Open the action directly below `Archive chat`, cancel once, then reopen and confirm. | Cancel keeps the chat. Confirm sends one `thread/delete` and no `thread/archive`; the chat leaves the active and pinned lists, and the current route moves to an adjacent chat when needed. | After reload, the chat is absent from both active and archived conversations. |

## Failure checks

1. Make the automation, fork, pin, rename, or archive request fail.
   - The UI must show or retain an actionable failure instead of silently presenting success.
   - If pin state cannot be loaded, pin and archive stay locked instead of overwriting unknown server state.
   - If removing a pin fails during archive, the archive action stops and the chat remains active.
2. Reload after each successful persistent action.
   - Only actions marked persistent above must survive reload.
   - Clipboard, navigation, and download actions must not create fake saved state.
3. Make the permanent-delete request fail.
   - The chat, current selection, and pin state must remain unchanged, and the error must remain visible.
4. After a successful permanent delete, query `thread/list` with both `archived:false` and `archived:true`.
   - The deleted chat id must be absent from both results.

## Rollback / cleanup

- Delete the disposable automation.
- Unpin and archive/delete disposable chats and forks.
- Remove downloaded ZIP files if no longer needed.
- Stop only the disposable `4173` process if this test started it.
