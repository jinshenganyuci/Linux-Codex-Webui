### Feature: Composer slash-command and dollar-skill autocomplete

#### Prerequisites

- Start the current worktree on `http://127.0.0.1:4173`.
- Open a new-chat or existing-thread composer with at least one installed Skill available for its current working directory.
- Test once in light theme and once in dark theme; include desktop, `375x812`, and `768x1024` viewports.

#### Steps

1. Focus an empty chat composer and type `/`.
2. Confirm a command palette opens above the composer and begins with `/model`, `/fast`, `/ide`, `/permissions`, `/keymap`, `/vim`, `/experimental`, and `/approve`.
3. Type `per`, then confirm the results are filtered and `/permissions` remains visible.
4. Use Arrow Down and Arrow Up to change the highlighted row, press Enter or Tab, and confirm the highlighted command is inserted into the composer without sending the message.
5. Clear the draft, type `/`, press Escape, and confirm the command palette closes while the draft remains unchanged.
6. Type `$` and confirm a Skill palette opens using the Skills available for the composer working directory. Verify each row shows its display name, `[Skill]`, and description.
7. Type part of an installed Skill name, confirm the list filters, then use Enter to select it.
8. Confirm the `$` token is removed, the selected Skill appears as a composer chip, and the input keeps keyboard focus.
9. Add a short prompt and send it. Confirm the sent user message retains the selected Skill metadata/chip.
10. Repeat the slash and Skill flows using mouse/touch selection in light and dark themes at desktop, `375x812`, and `768x1024` sizes.

#### Expected Results

- `/` opens a scrollable, keyboard-accessible command palette matching the Codex terminal command order and descriptions.
- `$` opens a filtered list from the already-loaded composer Skill data without an additional network request.
- Arrow keys wrap through results; Enter/Tab selects; Escape closes; pointer selection works without losing the draft.
- Slash selection inserts only the active slash token. Commands that accept inline arguments leave the caret after a trailing space.
- Skill selection attaches exactly one Skill even if the same Skill is selected again, and preserves all text outside the active `$` token.
- Menus stay inside each tested viewport and remain readable in light and dark themes.

#### Rollback/Cleanup

- Remove any unsent command text and selected Skill chips from the composer.
- Delete the smoke-test chat if step 9 created a disposable thread.
