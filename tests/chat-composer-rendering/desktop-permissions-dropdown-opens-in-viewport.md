### Feature: Desktop permissions dropdown opens inside the viewport

#### Prerequisites / setup

- Run the current app in a desktop browser at a viewport of at least 1280×720.
- Open a new or existing chat with the composer visible.
- Record the currently selected Codex permission mode so it can be restored.

#### Exact actions

1. Click the standalone permission control in the composer toolbar (for example, `完全访问`).
2. Confirm the permission list opens directly above the control and remains fully inside the browser viewport.
3. Click a different permission option and confirm the selected label updates and the menu closes.
4. Reopen the menu, click one of its options, and confirm the click is handled by the option instead of being treated as an outside click.
5. Repeat steps 1–4 in both light and dark themes.

#### Expected results

- The desktop permissions list is visible, correctly aligned near its trigger, and every option is clickable.
- Opening the list does not shift the page or place the menu relative to the composer glass surface.
- Selecting an option updates the permission mode and returns focus to the trigger.
- The existing mobile settings sheet remains unchanged.

#### Rollback / cleanup

- Restore the permission mode and theme recorded before the test.
