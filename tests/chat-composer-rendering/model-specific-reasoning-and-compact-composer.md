### Model-specific reasoning and compact composer

#### Feature/Change Name
The composer uses Codex model capabilities for reasoning choices and presents permissions, skills, model, context, and send controls in a compact responsive toolbar.

#### Prerequisites/Setup
1. Run the current checkout with a Codex app-server that returns model capabilities from `model/list`.
2. Ensure the model list contains a Sol model with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, plus a model such as Luna that does not support `ultra`.
3. Make light and dark themes available.
4. Test at 375x812, 768x1024, 1024x768, and 1440x900.

#### Steps
1. Open an idle thread and inspect the empty composer at each viewport.
2. Confirm the left toolbar group contains add, Codex permissions, and skills, while the right group contains model/reasoning, context usage, and send.
3. Select the Sol model, open the model/reasoning menu, and inspect all reasoning options.
4. Select `ultra`, close the menu, and inspect the compact trigger text.
5. With a catalog-supported model, enable Fast mode and confirm the bolt remains visible before the model and reasoning summary.
6. Reopen the menu, open the model side panel, select Luna, and inspect its reasoning options.
7. On desktop, verify the model side panel opens beside the reasoning panel. On mobile, verify it replaces the reasoning panel in the same layer.
8. Repeat steps 1-7 in dark theme.

#### Expected Results
- The empty composer is approximately 104-112px tall and no control overlaps, clips, or changes toolbar height.
- The model trigger reads as one summary such as `5.6-sol · Ultra`; long summaries truncate as a unit instead of truncating model and effort separately.
- Sol exposes exactly `Low`, `Medium`, `High`, `XHigh`, `Max`, and `Ultra`, using the official Codex display casing.
- Luna only exposes efforts returned for Luna and does not inherit Sol-only `Ultra`.
- Fast mode displays the bolt without hiding the model or reasoning summary only when the current model catalog exposes a Fast tier.
- The context ring remains 32px and the send button remains 36px, aligned to the same toolbar row.
- Menus close after a model or reasoning selection and remain fully inside the viewport.
- Light and dark menus have readable contrast with no light menu surface left behind in dark theme.

#### Rollback/Cleanup
- Restore the model, reasoning effort, Fast mode, and theme used before the test.

---
