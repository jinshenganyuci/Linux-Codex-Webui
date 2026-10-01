### Feature: Rollback appends rolled-back user text into composer input

#### Prerequisites
- App is running from this repository.
- Open any non-home thread with at least one completed user/assistant turn.
- Composer input is visible in the thread view.

#### Steps
1. In the selected thread, locate a message row with a visible rollback action.
2. Click rollback for a specific turn whose user prompt text is known.
3. Observe the composer input after the history mutation succeeds.
4. If composer already had text, verify the rolled-back user text is appended on a new line.
5. Confirm the thread rollback still completes and the turn is removed from the conversation.

#### Expected Results
- Only after the history mutation succeeds, the original user message text is inserted into the destination conversation composer. Failed mutations do not alter the draft.
- Existing composer draft text is preserved and the restored text is appended.
- Paginated revert and legacy rollback remove the selected turn and later turns. A modern runtime editing a legacy conversation opens a prefix fork instead, preserving the source conversation. Workspace files stay unchanged.
- If the user switches conversations while the request is pending, completion does not steal selection or insert text into the unrelated draft.

#### Rollback/Cleanup
- Clear composer input if restored text is no longer needed.
