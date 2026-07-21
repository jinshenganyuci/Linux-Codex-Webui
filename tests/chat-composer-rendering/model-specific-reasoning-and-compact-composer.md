### Model-specific reasoning and compact mobile composer

#### Feature/Change Name
The composer keeps common mobile actions immediately available while moving permissions and model/reasoning selection into a compact settings sheet.

#### Prerequisites/Setup
1. Run the current checkout with a Codex app-server that returns model capabilities from `model/list`.
2. Ensure the model list contains a Sol model with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, plus a model such as Luna that does not support `ultra`.
3. Make light and dark themes available.
4. Test at 375x812, 768x1024, 1024x768, and 1440x900.

#### Steps
1. At `375x812`, open an idle thread and inspect the empty composer. Confirm the placeholder is a single short line and the toolbar shows add, skills, a settings/model summary, and send without horizontal scrolling.
2. Tap the mobile settings/model summary. Confirm the bottom sheet is fully inside the viewport and has a close control, a Codex permissions selector, and a model/reasoning selector.
3. Change the permission mode in the sheet, close it, and reopen it. Confirm the selected permission persists and the main toolbar does not grow or overlap.
4. Select the Sol model, open the model/reasoning selector, and inspect all reasoning options. Select `ultra`, close the selector and sheet, and confirm the compact main summary updates.
5. Reopen the sheet, select Luna, and confirm only Luna-supported reasoning options are offered.
6. On mobile, open the skills picker from the main toolbar and confirm the list opens without focusing the search field or summoning the software keyboard. Tap the search field explicitly and confirm text input still works, then select a skill or prompt and verify the picker remains usable after opening and closing the settings sheet.
7. With a catalog-supported model, enable Fast mode from the attachment menu and confirm the model/reasoning selector remains usable.
8. Repeat steps 1-7 in dark theme, then repeat the toolbar inspection at `768x1024`, `1024x768`, and `1440x900`.

#### Expected Results
- At `375x812`, the empty composer keeps its controls on one usable toolbar row: add, skills, the settings/model summary, context when present, and send. No control overlaps, clips, or creates horizontal page overflow.
- The mobile settings trigger reads as one summary such as `5.6-sol · Ultra`; long summaries truncate as a unit instead of wrapping into a second control row.
- The settings sheet is above the composer, is dismissible by its close button or backdrop, and its interactive controls have a 44px touch target.
- Opening the mobile skills picker does not automatically focus its search field; the picker remains fully visible until the user searches, selects an item, or dismisses it.
- Desktop keeps the existing standalone permissions and model/reasoning controls rather than showing the mobile settings sheet.
- Sol exposes exactly `Low`, `Medium`, `High`, `XHigh`, `Max`, and `Ultra`, using the official Codex display casing.
- Luna only exposes efforts returned for Luna and does not inherit Sol-only `Ultra`.
- Fast mode displays the bolt without hiding the model or reasoning summary only when the current model catalog exposes a Fast tier.
- Menus close after a model or reasoning selection and remain fully inside the viewport and above the mobile settings sheet.
- Light and dark menus have readable contrast with no light menu surface left behind in dark theme.

#### Rollback/Cleanup
- Restore the model, reasoning effort, permission mode, Fast mode, selected skills, and theme used before the test.

---
