### Device-specific default send mode, chat width, and Codex-only provider

#### Feature/Change Name
New mobile browser profiles require Command/Ctrl+Enter to send, while new desktop profiles send with Enter. Both use the wide chat layout and expose only Codex as the provider.

#### Prerequisites/Setup
1. Start the current build on the verification port.
2. Use fresh desktop and mobile browser contexts, or remove only `codex-web-local.send-with-enter.v1` and `codex-web-local.chat-width.v1` from local storage in each context.
3. Have a usable Codex account available when verifying an actual send.

#### Steps
1. At a desktop viewport of at least 768px, open the home screen in light theme and open Settings.
2. Confirm “Require ⌘ + enter to send” is disabled and “Chat width” reads “Wide”.
3. At a mobile viewport below 768px, open the same fresh page and Settings, then confirm “Require ⌘ + enter to send” is enabled.
4. Confirm the Provider row shows `Codex` as a fixed value and offers no provider dropdown, API-key field, endpoint field, or API-format control.
5. On desktop, type a draft and press Enter; confirm the draft uses the direct-send path. On mobile, type a draft and press Enter; confirm it remains in the composer until the send button or Command/Ctrl+Enter path is used.
6. Save the opposite send preference in each context, reload at the same viewport, and confirm the explicit stored preference remains unchanged.
7. Repeat the desktop and mobile Settings checks in dark theme.

#### Expected Results
- Fresh desktop profiles disable the modifier requirement; fresh mobile profiles enable it. Both retain the Wide layout.
- Existing valid stored preferences are not overwritten.
- Codex is the only provider surface, with no external-provider configuration controls.
- The settings row, value chips, and composer remain readable in light and dark themes.

#### Rollback/Cleanup
- Restore or remove the two local-storage keys used during verification.
- Return the appearance setting to the preferred theme.
